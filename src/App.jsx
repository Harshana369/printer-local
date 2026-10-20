import { useEffect, useState, useCallback, useRef } from "react";
import {
  EscPos,
  findPrinter,
  pickPrinter,
  forgetPrinter,
  printBytes,
  isSupported,
  isSecure,
} from "./printer";
import { listPrinters, printViaServer } from "./networkPrint";

const ITEMS = [
  { name: "Espresso", qty: 2, price: 3.5 },
  { name: "Croissant", qty: 1, price: 4.25 },
  { name: "Orange juice", qty: 1, price: 5.0 },
];

function buildReceipt() {
  const total = ITEMS.reduce((s, i) => s + i.qty * i.price, 0);
  const p = new EscPos();
  p.align("center").bold(true).size(2, 2).line("MY CAFE").size(1, 1).bold(false)
    .line("123 Main Street")
    .line(new Date().toLocaleString())
    .line("-".repeat(42))
    .align("left");
  ITEMS.forEach((i) =>
    p.row(`${i.name} x${i.qty}`, (i.qty * i.price).toFixed(2))
  );
  p.line("-".repeat(42))
    .bold(true).row("TOTAL", total.toFixed(2)).bold(false)
    .feed(1).align("center").line("Thank you!")
    .feed(4).cut();
  return p.build();
}

export default function App() {
  const [nameHint, setNameHint] = useState(
    () => JSON.parse(localStorage.getItem("pos-printer") || "{}").name || ""
  );
  const [device, setDevice] = useState(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(() => localStorage.getItem("pos-mode") || "usb"); // usb | system | network
  const [osPrinters, setOsPrinters] = useState([]);
  const [osPrinter, setOsPrinter] = useState(() => localStorage.getItem("pos-os-printer") || "");
  const [ip, setIp] = useState(() => localStorage.getItem("pos-ip") || "192.168.1.50");

  useEffect(() => {
    localStorage.setItem("pos-mode", mode);
    if (mode === "system") {
      listPrinters()
        .then(setOsPrinters)
        .catch((e) => setStatus(e.message));
    }
  }, [mode]);

  const hintRef = useRef(nameHint);
  useEffect(() => { hintRef.current = nameHint; }, [nameHint]);
  const label = (d) => d.productName || `USB ${d.vendorId.toString(16)}:${d.productId.toString(16)}`;

  // Auto-reconnect to a previously approved printer (no popup)
  const reconnect = useCallback(async () => {
    if (!isSupported()) return;
    try {
      const d = await findPrinter(hintRef.current);
      setDevice(d);
      setStatus(d ? `Ready: ${label(d)}` : "No matching printer. Click Choose printer.");
    } catch (e) {
      setStatus(e.message);
    }
  }, []);

  useEffect(() => {
    if (!isSupported()) return;
    reconnect();
    const onConnect = () => reconnect();
    const onDisconnect = (e) => {
      setDevice((cur) => {
        if (cur && cur === e.device) {
          setStatus(`Disconnected: ${label(cur)}`);
          return null;
        }
        return cur;
      });
    };
    navigator.usb.addEventListener("connect", onConnect);
    navigator.usb.addEventListener("disconnect", onDisconnect);
    return () => {
      navigator.usb.removeEventListener("connect", onConnect);
      navigator.usb.removeEventListener("disconnect", onDisconnect);
    };
  }, [reconnect]);

  const choose = async () => {
    try {
      const d = await pickPrinter(); // must run from a click
      setDevice(d);
      setNameHint(d.productName || "");
      setStatus(`Ready: ${label(d)}`);
    } catch (e) {
      setStatus(e.name === "NotFoundError" ? "No printer selected." : e.message);
    }
  };

  const print = async () => {
    setBusy(true);
    try {
      const bytes = buildReceipt();
      if (mode === "usb") {
        const d = device || (await findPrinter(nameHint));
        if (d) setDevice(d);
        if (!d) throw new Error("Printer not found. Choose a printer first.");
        await printBytes(d, bytes);
      } else if (mode === "system") {
        if (!osPrinter) throw new Error("Select an installed printer.");
        localStorage.setItem("pos-os-printer", osPrinter);
        await printViaServer(bytes, { printer: osPrinter });
      } else {
        localStorage.setItem("pos-ip", ip);
        await printViaServer(bytes, { host: ip, port: 9100 });
      }
      setStatus("Printed.");
    } catch (e) {
      setStatus(`Print failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const field = { display: "block", width: "100%", padding: 8, marginTop: 4 };

  return (
    <main style={{ maxWidth: 480, margin: "40px auto", fontFamily: "system-ui", padding: 16 }}>
      <h1>POS receipt printing</h1>

      <label style={{ display: "block", marginBottom: 12 }}>
        Connection
        <select value={mode} onChange={(e) => setMode(e.target.value)} style={field}>
          <option value="usb">USB direct (WebUSB, Chrome only)</option>
          <option value="system">Installed printer (Printers &amp; devices)</option>
          <option value="network">Network printer by IP</option>
        </select>
      </label>

      {mode === "usb" && (
        <>
          {!isSupported() && (
            <p style={{ color: "crimson" }}>
              {isSecure()
                ? "This browser has no WebUSB. Use Chrome or Edge."
                : "WebUSB only works on HTTPS or http://localhost. Open this page via localhost (or HTTPS) instead of an IP address."}
            </p>
          )}
          <label style={{ display: "block", marginBottom: 12 }}>
            Printer name (USB product name)
            <input
              value={nameHint}
              onChange={(e) => setNameHint(e.target.value)}
              onBlur={reconnect}
              placeholder="e.g. POS-80"
              style={field}
            />
          </label>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button onClick={choose} disabled={!isSupported()}>Choose printer</button>
            <button onClick={() => { forgetPrinter(device); setDevice(null); setNameHint(""); setStatus("Printer forgotten."); }}>
              Forget printer
            </button>
          </div>
        </>
      )}

      {mode === "system" && (
        <label style={{ display: "block", marginBottom: 12 }}>
          Installed printer
          <select value={osPrinter} onChange={(e) => setOsPrinter(e.target.value)} style={field}>
            <option value="">Select a printer</option>
            {osPrinters.map((p) => (
              <option key={p.Name} value={p.Name}>{p.Name}</option>
            ))}
          </select>
        </label>
      )}

      {mode === "network" && (
        <label style={{ display: "block", marginBottom: 12 }}>
          Printer IP address (port 9100)
          <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.50" style={field} />
        </label>
      )}

      <button onClick={print} disabled={busy || (mode === "usb" && !device)}>
        {busy ? "Printing…" : "Print receipt"}
      </button>

      <p role="status" style={{ marginTop: 16 }}>{status}</p>
    </main>
  );
}
