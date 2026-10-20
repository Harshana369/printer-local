// Run on the POS PC (or any machine that can see the printer).
//   POST /print?printer=<printer name>        -> printer installed in the OS
//   POST /print?host=192.168.1.50&port=9100   -> raw TCP to a network printer
//   GET  /printers                            -> printers installed in the OS
import express from "express";
import cors from "cors";
import net from "net";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const run = promisify(execFile);
const app = express();

const LAN_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;


// Chrome asks for this on requests from a LAN page to a local service
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  next();
});
app.use(cors({ origin: (origin, cb) => cb(null, !origin || LAN_ORIGIN.test(origin)) }));
app.use(express.raw({ type: "application/octet-stream", limit: "2mb" }));

const SAFE_NAME = /^[\w .\-]+$/; // blocks shell-special characters

// ---- list OS printers ----
app.get("/printers", async (_req, res) => {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("powershell", [
        "-NoProfile",
        "-Command",
        "Get-Printer | Select-Object Name,ShareName,Shared | ConvertTo-Json",
      ]);
      const list = [].concat(JSON.parse(stdout || "[]"));
      return res.json(list);
    }
    const { stdout } = await run("lpstat", ["-e"]);
    res.json(stdout.split("\n").filter(Boolean).map((Name) => ({ Name, ShareName: Name })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- raw TCP (network printers, port 9100) ----
function printTcp(host, port, data) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: 5000 }, () => {
      socket.write(data, () => socket.end());
    });
    socket.on("close", resolve);
    socket.on("timeout", () => { socket.destroy(); reject(new Error(`Timed out connecting to ${host}:${port}. Check the IP and that the printer is on the same network.`)); });
    socket.on("error", (e) => {
      const hints = {
        ECONNREFUSED: `Printer at ${host} refused port ${port}. Raw/9100 printing may be disabled or the port differs.`,
        EHOSTUNREACH: `No route to ${host}. Wrong IP or different subnet.`,
        ENETUNREACH: `Network unreachable for ${host}.`,
        ETIMEDOUT: `Connection to ${host}:${port} timed out.`,
      };
      reject(new Error(hints[e.code] || e.message));
    });
  });
}

// ---- Windows: send RAW bytes through the spooler (no sharing needed) ----
// Printer name and file path come in through env vars, never the script text.
const WIN_RAW_PRINT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Win32Exception();
    try {
      DOCINFO di = new DOCINFO { pDocName = "POS receipt", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) throw new Win32Exception();
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, data, data.Length, out written)) throw new Win32Exception();
        if (written != data.Length) throw new Exception("Printer accepted only " + written + " of " + data.Length + " bytes");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
[RawPrinter]::Send($env:POS_PRINTER, [IO.File]::ReadAllBytes($env:POS_FILE))
`;

// ---- OS printer by name (raw, no driver rendering) ----
async function printOs(name, data) {
  if (!SAFE_NAME.test(name)) throw new Error("Invalid printer name");
  const file = path.join(os.tmpdir(), `receipt-${Date.now()}.bin`);
  await fs.writeFile(file, data);
  try {
    if (process.platform === "win32") {
      try {
        await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WIN_RAW_PRINT], {
          env: { ...process.env, POS_PRINTER: name, POS_FILE: file },
        });
      } catch (e) {
        const detail = (e.stderr || e.message).split("\n").find((l) => /Exception|error/i.test(l)) || e.message;
        throw new Error(`Windows could not print to "${name}": ${detail.trim()}`, { cause: e });
      }
    } else {
      await run("lp", ["-d", name, "-o", "raw", file]);
    }
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

app.post("/print", async (req, res) => {
  try {
    const data = req.body;
    if (!Buffer.isBuffer(data) || !data.length) throw new Error("Empty body");
    const { printer, host, port } = req.query;

    if (host) await printTcp(host, Number(port) || 9100, data);
    else if (printer) await printOs(String(printer), data);
    else throw new Error("Provide ?printer= or ?host=");

    res.json({ ok: true });
  } catch (e) {
    console.error("Print error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(3001, "127.0.0.1", () => console.log("Print service on http://127.0.0.1:3001"));