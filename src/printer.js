// WebUSB printer helper (Chrome / Edge, HTTPS or localhost only)
// WebUSB has no "printer name" list like the OS does. Instead we match the
// device by its USB productName (e.g. "POS-80") or by vendorId/productId.

const SAVED_KEY = "pos-printer";
const PRINTER_CLASS = 0x07; // USB printer interface class

// ---------- ESC/POS builder ----------
// Thermal printers use single-byte code pages (CP437 by default), not UTF-8.
// Map anything outside ASCII to something printable so the receipt never
// shows garbage (e.g. Chrome's toLocaleString() puts U+202F before "PM").
function toAscii(s) {
  return String(s)
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\n -~]/g, "?");
}

export class EscPos {
  constructor() {
    this.bytes = [0x1b, 0x40]; // initialize
  }
  raw(...b) { this.bytes.push(...b); return this; }
  text(s = "") {
    const a = toAscii(s);
    for (let i = 0; i < a.length; i++) this.bytes.push(a.charCodeAt(i));
    return this;
  }
  line(s = "") { return this.text(s + "\n"); }
  align(a) { return this.raw(0x1b, 0x61, { left: 0, center: 1, right: 2 }[a] ?? 0); }
  bold(on) { return this.raw(0x1b, 0x45, on ? 1 : 0); }
  size(w = 1, h = 1) { return this.raw(0x1d, 0x21, ((w - 1) << 4) | (h - 1)); }
  feed(n = 3) { return this.raw(0x1b, 0x64, n); }
  cut() { return this.raw(0x1d, 0x56, 0x00); }
  // two-column row, e.g. "Coffee x2        7.00"
  row(left, right, width = 42) {
    left = toAscii(left);
    right = toAscii(right);
    if (left.length + right.length + 1 > width) left = left.slice(0, Math.max(0, width - right.length - 1));
    const gap = Math.max(1, width - left.length - right.length);
    return this.line(left + " ".repeat(gap) + right);
  }
  build() { return new Uint8Array(this.bytes); }
}

// ---------- device lookup ----------
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY)); } catch { return null; }
}

function matches(device, want) {
  if (!want) return false;
  if (want.vendorId != null &&
      want.vendorId === device.vendorId && want.productId === device.productId) return true;
  return !!(want.name && device.productName &&
      device.productName.toLowerCase().includes(want.name.toLowerCase()));
}

/** Find an already-permitted printer with no popup. `nameHint` narrows/overrides the saved one. */
export async function findPrinter(nameHint) {
  if (!isSupported()) return null;
  const devices = await navigator.usb.getDevices();
  const saved = loadSaved();
  // Keep the saved vendor/product ids unless the user typed a different name,
  // so printers with no USB product string still reconnect.
  const want = nameHint && nameHint !== saved?.name ? { name: nameHint } : saved;
  return devices.find((d) => matches(d, want)) ?? null;
}

/** Show Chrome's device picker (needs a click). Saves the choice for next time. */
export async function pickPrinter() {
  const device = await navigator.usb.requestDevice({ filters: [] });
  localStorage.setItem(
    SAVED_KEY,
    JSON.stringify({
      name: device.productName || "",
      vendorId: device.vendorId,
      productId: device.productId,
    })
  );
  return device;
}

export async function forgetPrinter(device) {
  localStorage.removeItem(SAVED_KEY);
  // Also revoke Chrome's permission so it stops auto-reconnecting
  try { await device?.forget?.(); } catch { /* ignore */ }
}

// ---------- open + write ----------
function friendlyError(e) {
  const msg = e?.message || String(e);
  if (/claim interface|Access denied|SecurityError/i.test(`${e?.name} ${msg}`)) {
    return new Error(
      "The OS printer driver is holding the USB printer, so the browser can't use it. " +
      "On Windows install the WinUSB driver for this printer with Zadig (zadig.akeo.ie), " +
      "or use the \"Installed printer\" mode instead. Also close other tabs/apps using it."
    );
  }
  if (e?.name === "NotFoundError" || /disconnected|No device selected/i.test(msg)) {
    return new Error("Printer disconnected. Check the cable/power and choose the printer again.");
  }
  return e instanceof Error ? e : new Error(msg);
}

/** Pick the interface + alternate that carries a bulk OUT endpoint (prefer printer class). */
function findBulkOut(config) {
  const candidates = [];
  for (const iface of config.interfaces) {
    for (const alt of iface.alternates) {
      const ep = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
      if (ep) candidates.push({ iface, alt, ep });
    }
  }
  return candidates.find((c) => c.alt.interfaceClass === PRINTER_CLASS) ?? candidates[0];
}

async function openDevice(device) {
  if (!device.opened) await device.open();
  if (device.configuration === null) {
    await device.selectConfiguration(device.configurations[0]?.configurationValue ?? 1);
  }

  const found = findBulkOut(device.configuration);
  if (!found) throw new Error("No bulk OUT endpoint found. Is this device really a printer?");
  const { iface, alt, ep } = found;

  if (!iface.claimed) await device.claimInterface(iface.interfaceNumber);
  if (iface.alternate?.alternateSetting !== alt.alternateSetting) {
    await device.selectAlternateInterface(iface.interfaceNumber, alt.alternateSetting);
  }
  return { endpoint: ep.endpointNumber, packetSize: ep.packetSize || 64 };
}

async function closeQuietly(device) {
  try { if (device.opened) await device.close(); } catch { /* ignore */ }
}

// Serialize jobs: two overlapping open()/transferOut() calls on the same device fail.
let queue = Promise.resolve();

export function printBytes(device, bytes) {
  const job = queue.then(() => doPrint(device, bytes));
  queue = job.catch(() => {});
  return job;
}

async function doPrint(device, bytes) {
  let endpoint;
  try {
    ({ endpoint } = await openDevice(device));
  } catch (e) {
    await closeQuietly(device); // leave it clean so the next try can reopen
    throw friendlyError(e);
  }

  const CHUNK = 4096;
  try {
    for (let i = 0; i < bytes.length; ) {
      const chunk = bytes.slice(i, i + CHUNK);
      let result = await device.transferOut(endpoint, chunk);
      if (result.status === "stall") {
        await device.clearHalt("out", endpoint);
        result = await device.transferOut(endpoint, chunk);
      }
      if (result.status !== "ok") throw new Error(`USB transfer failed (${result.status}).`);
      if (!result.bytesWritten) throw new Error("Printer accepted no data (paper out or cover open?).");
      i += result.bytesWritten;
    }
  } catch (e) {
    await closeQuietly(device);
    throw friendlyError(e);
  }
}

export const isSupported = () => typeof navigator !== "undefined" && "usb" in navigator;
export const isSecure = () => typeof window !== "undefined" && window.isSecureContext;
