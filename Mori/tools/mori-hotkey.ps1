# Mori Console : raccourci de la console dans Premiere Pro (Windows ; Ctrl+Espace par défaut, modifiable dans ses réglages)
#
# Lancé (caché) par Mori. Le raccourci n'est réservé que lorsque la fenêtre au premier plan est Premiere Pro :
# ailleurs, Ctrl+Espace garde son rôle habituel. À chaque appui, écrit « HOTKEY » sur la sortie standard ; Mori
# ouvre alors la console. S'arrête quand la fenêtre Mori qui l'a lancé se ferme (ou Premiere). Une seule
# instance tient le raccourci (mutex) : une autre attend sans rien consommer et prend le relais si la première s'arrête.
# « HIDE » reçu sur l'entrée standard : masque la fenêtre de la console au lieu de la fermer (la rouvrir ne relance
# alors aucun processus : pas de curseur « démarrage en cours », affichage immédiat) ; répond « HIDDEN n ».
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
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  static readonly object gate = new object();
  static List<IntPtr> hiddenWindows = new List<IntPtr>();

  // fenêtres de la console (titre de sa page), visibles ou non
  static List<IntPtr> ConsoleWindows(bool visibleOnly) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      var s = new System.Text.StringBuilder(64);
      GetWindowText(h, s, 64);
      if (s.ToString() == "Mori Console" && (!visibleOnly || IsWindowVisible(h))) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  static void HideConsole() {
    lock (gate) {
      var list = ConsoleWindows(true);
      foreach (var h in list) { ShowWindow(h, 0); if (!hiddenWindows.Contains(h)) hiddenWindows.Add(h); }
      Console.Out.WriteLine("HIDDEN " + list.Count);
      Console.Out.Flush();
    }
  }
  // raccourci pressé : la console masquée réapparaît tout de suite, avant même que Mori ne la demande
  static void ShowHiddenConsole() {
    lock (gate) {
      if (hiddenWindows.Count == 0) return;
      var alive = ConsoleWindows(false);
      IntPtr first = IntPtr.Zero;
      foreach (var h in hiddenWindows) {
        if (!alive.Contains(h)) continue;
        ShowWindow(h, 5);
        if (first == IntPtr.Zero) first = h;
      }
      hiddenWindows.Clear();
      if (first != IntPtr.Zero) SetForegroundWindow(first);
    }
  }

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
    var watcher = new Thread(() => {
      try {
        string line;
        while ((line = Console.In.ReadLine()) != null) { if (line.Trim() == "HIDE") HideConsole(); }
      } catch { }
      Environment.Exit(0);
    });
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
        ShowHiddenConsole();
        lock (gate) { Console.Out.WriteLine("HOTKEY"); Console.Out.Flush(); }
      }
      Thread.Sleep(60);
    }
    if (registered) UnregisterHotKey(IntPtr.Zero, 1);
    try { mutex.ReleaseMutex(); } catch { }
  }
}
"@

[MoriHotkey]::Run($PremierePid, [uint32]$Vk, [uint32]$Mods)
