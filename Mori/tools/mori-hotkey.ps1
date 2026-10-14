# Mori Console : raccourci de la console dans Premiere Pro (Windows ; Ctrl+Espace par défaut, modifiable dans ses réglages)
#
# Lancé (caché) par Mori. Le raccourci n'est réservé que lorsque la fenêtre au premier plan est Premiere Pro :
# ailleurs, Ctrl+Espace garde son rôle habituel. À chaque appui, écrit « HOTKEY » sur la sortie standard ; Mori
# ouvre alors la console. S'arrête quand la fenêtre Mori qui l'a lancé se ferme (ou Premiere). Une seule
# instance tient le raccourci (mutex) : une autre attend sans rien consommer et prend le relais si la première s'arrête.
# -Vk : touche (code Windows) ; -Mods : Alt 1, Ctrl 2, Maj 4, Win 8
param([int]$PremierePid = 0, [int]$Vk = 32, [int]$Mods = 2)

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class MoriHotkey {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)]
  struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint min, uint max, uint remove);

  const uint MOD_NOREPEAT = 0x4000, WM_HOTKEY = 0x0312;
  static readonly Dictionary<uint, bool> isPremiere = new Dictionary<uint, bool>();

  static bool PremiereInFront() {
    uint pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    if (pid == 0) return false;
    bool known;
    if (isPremiere.TryGetValue(pid, out known)) return known;
    bool yes = false;
    try { yes = Process.GetProcessById((int)pid).ProcessName.StartsWith("Adobe Premiere Pro", StringComparison.OrdinalIgnoreCase); } catch { }
    if (isPremiere.Count > 200) isPremiere.Clear();
    isPremiere[pid] = yes;
    return yes;
  }

  public static void Run(int premierePid, uint vk, uint mods) {
    // la fenêtre Mori qui nous a lancés se ferme : son tube se ferme, on s'arrête
    var watcher = new Thread(() => { try { while (Console.In.Read() != -1) { } } catch { } Environment.Exit(0); });
    watcher.IsBackground = true;
    watcher.Start();
    var mutex = new Mutex(false, @"Local\MoriConsoleHotkey");
    try { mutex.WaitOne(); } catch (AbandonedMutexException) { }
    bool registered = false;
    int tick = 0;
    Console.Out.WriteLine("READY");
    Console.Out.Flush();
    while (true) {
      // Premiere fermé : on s'arrête (contrôle toutes les ~2 s)
      if (premierePid > 0 && ++tick % 30 == 0) {
        try { if (Process.GetProcessById(premierePid).HasExited) break; } catch { break; }
      }
      bool front = PremiereInFront();
      if (front && !registered) registered = RegisterHotKey(IntPtr.Zero, 1, mods | MOD_NOREPEAT, vk);
      else if (!front && registered) { UnregisterHotKey(IntPtr.Zero, 1); registered = false; }
      MSG msg;
      while (PeekMessage(out msg, IntPtr.Zero, WM_HOTKEY, WM_HOTKEY, 1)) {
        Console.Out.WriteLine("HOTKEY");
        Console.Out.Flush();
      }
      Thread.Sleep(60);
    }
    if (registered) UnregisterHotKey(IntPtr.Zero, 1);
    try { mutex.ReleaseMutex(); } catch { }
  }
}
"@

[MoriHotkey]::Run($PremierePid, [uint32]$Vk, [uint32]$Mods)
