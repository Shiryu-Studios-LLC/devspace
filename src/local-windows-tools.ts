import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const ALLOWED_PROCESSES = [
  "Minecraft.Windows.exe", "Unity.exe", "UnrealEditor.exe", "Blockbench.exe",
] as const;
const DEFAULT_PROCESSES = ["Minecraft.Windows.exe"] as const;
const annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

type Json = Record<string, unknown>;
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function response(tool: string, data: Json, content?: Content[]) {
  const result = JSON.stringify(data);
  return { content: content ?? [{ type: "text" as const, text: result }], structuredContent: { result, ...data } };
}

function allowed(requested?: string[]): string[] {
  const known = new Map(ALLOWED_PROCESSES.map((name) => [name.toLowerCase(), name]));
  return [...new Set((requested?.length ? requested : DEFAULT_PROCESSES).map((raw) => {
    const normalized = raw.trim().toLowerCase().endsWith(".exe") ? raw.trim() : `${raw.trim()}.exe`;
    const canonical = known.get(normalized.toLowerCase());
    if (!canonical) throw new Error(`Process ${normalized} is not in the DevSpace computer-control allowlist.`);
    return canonical;
  }))];
}

function powershell(script: string, input: Json): Json {
  if (process.platform !== "win32") throw new Error("Windows computer control is available only on Windows hosts.");
  const path = `${process.env.TEMP ?? "."}\\devspace-control-${randomUUID()}.ps1`;
  writeFileSync(path, script, "utf8");
  try {
    const stdout = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path,
      "-InputJson", JSON.stringify(input)], { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout.trim()) as Json;
  } finally { rmSync(path, { force: true }); }
}

const CONTROL_SCRIPT = String.raw`
param([string]$InputJson)
$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing
$i=$InputJson|ConvertFrom-Json
$src=@'
using System; using System.Text; using System.Runtime.InteropServices;
public static class DSNative {
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int n);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,int x,int y,uint d,UIntPtr e);
 [DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);
 public struct RECT { public int Left,Top,Right,Bottom; }
}
'@
if(-not ('DSNative' -as [type])){Add-Type $src}
$wins=@(); $allow=@($i.allowedProcesses|%{"$_".ToLowerInvariant()})
$cb=[DSNative+EnumProc]{param($h,$l); if([DSNative]::IsWindowVisible($h)){[uint32]$pid=0;[void][DSNative]::GetWindowThreadProcessId($h,[ref]$pid);$p=Get-Process -Id $pid -ErrorAction SilentlyContinue;$exe=if($p){$p.ProcessName+'.exe'}else{''};if($allow -contains $exe.ToLowerInvariant()){$b=New-Object Text.StringBuilder 512;[void][DSNative]::GetWindowText($h,$b,512);$wins+=@([pscustomobject]@{hwnd=$h.ToInt64();pid=$pid;process=$exe;title=$b.ToString()})}};$true}
[void][DSNative]::EnumWindows($cb,[IntPtr]::Zero)
$w=$wins|?{(-not $i.hwnd-or$_.hwnd-eq$i.hwnd)-and(-not $i.pid-or$_.pid-eq$i.pid)-and(-not $i.titleContains-or$_.title-like('*'+$i.titleContains+'*'))}|select -First 1
if($i.action-eq'list'){@{windows=$wins}|ConvertTo-Json -Depth 5 -Compress;exit};if(-not $w){throw 'No visible allowlisted window matched the request.'}
$h=[IntPtr]$w.hwnd;$r=New-Object DSNative+RECT;[void][DSNative]::GetWindowRect($h,[ref]$r);$geo=@{left=$r.Left;top=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top}
function VKey($key){$k="$key".ToUpperInvariant();$map=@{'BACKSPACE'=8;'TAB'=9;'ENTER'=13;'SHIFT'=16;'CTRL'=17;'CONTROL'=17;'ALT'=18;'ESC'=27;'ESCAPE'=27;'SPACE'=32;'LEFT'=37;'UP'=38;'RIGHT'=39;'DOWN'=40;'DELETE'=46;'INSERT'=45;'HOME'=36;'END'=35;'PAGEUP'=33;'PAGEDOWN'=34;'LSHIFT'=160;'RSHIFT'=161;'LCTRL'=162;'RCTRL'=163;'LALT'=164;'RALT'=165;'/'=191};if($map.ContainsKey($k)){return[byte]$map[$k]};if($k-match'^F([1-9]|1[0-9]|2[0-4])$'){return[byte](112+[int]$Matches[1]-1)};if($k.Length-eq1){return[byte][char]$k};throw "Unsupported key '$key'."}
function KeyDown($key){[DSNative]::keybd_event((VKey $key),0,0,[UIntPtr]::Zero)};function KeyUp($key){[DSNative]::keybd_event((VKey $key),0,2,[UIntPtr]::Zero)}
if($i.action-eq'focus'){[void][DSNative]::ShowWindow($h,9);[void][DSNative]::SetForegroundWindow($h)}
elseif($i.action-eq'key'){[void][DSNative]::SetForegroundWindow($h);$mode=if($i.mode){"$($i.mode)"}else{'press'};if($mode-eq'down'){KeyDown $i.key}elseif($mode-eq'up'){KeyUp $i.key}else{KeyDown $i.key;Start-Sleep -Milliseconds $(if($i.durationMs){[int]$i.durationMs}else{60});KeyUp $i.key}}
elseif($i.action-eq'text'){[void][DSNative]::SetForegroundWindow($h);[System.Windows.Forms.Clipboard]::SetText("$($i.text)");[System.Windows.Forms.SendKeys]::SendWait('^v')}
elseif($i.action -like 'mouse*'){$x=$r.Left+[int]$(if($null-ne$i.x){$i.x}else{($r.Right-$r.Left)/2});$y=$r.Top+[int]$(if($null-ne$i.y){$i.y}else{($r.Bottom-$r.Top)/2});[void][DSNative]::SetCursorPos($x,$y);if($i.action-eq'mouseClick'){[DSNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[DSNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)}elseif($i.action-eq'mouseDrag'){$ex=$r.Left+[int]$i.endX;$ey=$r.Top+[int]$i.endY;[DSNative]::mouse_event(2,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 80;[void][DSNative]::SetCursorPos($ex,$ey);Start-Sleep -Milliseconds $(if($i.durationMs){[int]$i.durationMs}else{150});[DSNative]::mouse_event(4,0,0,0,[UIntPtr]::Zero)}elseif($i.action-eq'mouseScroll'){[DSNative]::mouse_event(2048,0,0,[uint32][int]$i.delta,[UIntPtr]::Zero)}elseif($i.action-eq'mouseDelta'){[DSNative]::mouse_event(1,[int]$i.dx,[int]$i.dy,0,[UIntPtr]::Zero)}}
@{window=$w;geometry=$geo;action=$i.action}|ConvertTo-Json -Depth 5 -Compress
`;

function run(action: string, input: Json): Json {
  return powershell(CONTROL_SCRIPT, { ...input, action, allowedProcesses: allowed(input.allowedProcesses as string[] | undefined) });
}

const target = {
  allowedProcesses: z.array(z.enum(ALLOWED_PROCESSES)).optional(), hwnd: z.number().optional(), pid: z.number().optional(), titleContains: z.string().optional(),
};

export function registerLocalWindowsTools(server: McpServer, _config: ServerConfig, workspaces: WorkspaceRegistry): void {
  registerAppTool(server, "computer_allowed_processes", { title: "Computer Control Allowlist", description: "Show the fixed executable allowlist.", inputSchema: {}, _meta: {}, annotations: readAnnotations }, async () => response("computer_allowed_processes", { allowedProcesses: ALLOWED_PROCESSES, defaultAllowedProcesses: DEFAULT_PROCESSES }));
  registerAppTool(server, "computer_windows", { title: "Computer Windows", description: "List visible allowlisted windows.", inputSchema: { allowedProcesses: target.allowedProcesses }, _meta: {}, annotations: readAnnotations }, async (i) => response("computer_windows", run("list", i)));
  const reg = (name: string, title: string, action: string, extra: Json = {}) => registerAppTool(server, name, { title, description: `${title} in a revalidated allowlisted window.`, inputSchema: { ...target, ...extra }, _meta: {}, annotations }, async (i) => response(name, run(action, i)));
  reg("computer_focus_window", "Computer Focus Window", "focus");
  reg("computer_window_geometry", "Computer Window Geometry", "geometry");
  reg("computer_press_key", "Computer Press Key", "key", { key: z.string(), durationMs: z.number().int().min(1).max(10_000).optional() });
  reg("computer_hold_key", "Computer Hold Key", "key", { key: z.string(), mode: z.literal("down").default("down") });
  reg("computer_release_key", "Computer Release Key", "key", { key: z.string(), mode: z.literal("up").default("up") });
  reg("computer_type_text", "Computer Type Text", "text", { text: z.string() });
  reg("computer_mouse_click", "Computer Mouse Click", "mouseClick", { x: z.number().optional(), y: z.number().optional() });
  reg("computer_mouse_drag", "Computer Mouse Drag", "mouseDrag", { x: z.number().optional(), y: z.number().optional(), endX: z.number(), endY: z.number(), durationMs: z.number().int().min(1).max(10_000).optional() });
  reg("computer_mouse_scroll", "Computer Mouse Scroll", "mouseScroll", { delta: z.number() });
  reg("computer_mouse_delta", "Computer Mouse Delta", "mouseDelta", { dx: z.number(), dy: z.number() });
  const minecraft = (name: string, title: string, action: string, extra: Json = {}, map: (input: Json) => Json = (input) => input) => registerAppTool(server, name, { title, description: `${title}; only Minecraft.Windows.exe is permitted.`, inputSchema: extra, _meta: {}, annotations }, async (i: Json) => response(name, run(action, { ...map(i), allowedProcesses: ["Minecraft.Windows.exe"] })));
  minecraft("minecraft_focus", "Minecraft Focus", "focus"); minecraft("minecraft_press_key", "Minecraft Press Key", "key", { key: z.string() });
  minecraft("minecraft_hold_key", "Minecraft Hold Key", "key", { key: z.string() }, (i) => ({ ...i, mode: "down" })); minecraft("minecraft_release_key", "Minecraft Release Key", "key", { key: z.string() }, (i) => ({ ...i, mode: "up" }));
  minecraft("minecraft_type_command", "Minecraft Type Command", "text", { command: z.string() }, (i) => ({ text: `/${String(i.command).replace(/^\/+/, "")}~` })); minecraft("minecraft_select_hotbar", "Minecraft Select Hotbar", "key", { slot: z.number().int().min(1).max(9) }, (i) => ({ key: String(i.slot) }));
  minecraft("minecraft_interact", "Minecraft Interact", "mouseClick"); minecraft("minecraft_use_item", "Minecraft Use Item", "mouseClick");

  const screenshot = async ({ workspaceId, path = `.devspace/screenshots/screenshot-${new Date().toISOString().replaceAll(":", "-")}.png` }: { workspaceId: string; path?: string }) => {
    const workspace = workspaces.getWorkspace(workspaceId); const destination = resolve(workspace.root, path); const rel = relative(workspace.root, destination);
    if (rel.startsWith("..") || rel.includes(":") || !destination.toLowerCase().endsWith(".png")) throw new Error("Screenshot path must be a workspace-relative PNG path.");
    mkdirSync(dirname(destination), { recursive: true });
    const script = `param([string]$InputJson)\n$i=$InputJson|ConvertFrom-Json;Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;$m=New-Object Drawing.Bitmap $b.Width,$b.Height;$g=[Drawing.Graphics]::FromImage($m);try{$g.CopyFromScreen($b.Left,$b.Top,0,0,$b.Size);$m.Save($i.path,[Drawing.Imaging.ImageFormat]::Png);@{width=$b.Width;height=$b.Height}|ConvertTo-Json -Compress}finally{$g.Dispose();$m.Dispose()}`;
    const metadata = powershell(script, { path: destination }); const content: Content[] = [{ type: "text", text: `Captured screenshot ${path}.` }, { type: "image", data: readFileSync(destination).toString("base64"), mimeType: "image/png" }];
    return response("screenshot", { path, ...metadata }, content);
  };
  registerAppTool(server, "screenshot", { title: "Screenshot", description: "Capture the Windows virtual desktop into an open workspace.", inputSchema: { workspaceId: z.string(), path: z.string().optional() }, _meta: {}, annotations }, screenshot);
  registerAppTool(server, "minecraft_screenshot", { title: "Minecraft Screenshot", description: "Capture the desktop while using the Minecraft tool set.", inputSchema: { workspaceId: z.string(), path: z.string().optional() }, _meta: {}, annotations }, screenshot);
}
