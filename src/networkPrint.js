const API = "http://127.0.0.1:3001";

/** Printers installed in the OS (Printers & devices). */
export async function listPrinters() {
  const res = await fetch(`${API}/printers`);
  if (!res.ok) throw new Error("Print service not reachable");
  return res.json(); // [{ Name, ShareName, Shared }]
}

/**
 * Send ESC/POS bytes to the print service.
 * target = { printer: "POS80" }            // OS printer (share name)
 *       or { host: "192.168.1.50", port: 9100 }  // network printer
 */
export async function printViaServer(bytes, target) {
  const qs = new URLSearchParams(target).toString();
  const res = await fetch(`${API}/print?${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.error || "Print failed");
}
