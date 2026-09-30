// The Windows client: a window around the setup page, and nothing else (D-080).
//
// Same shape as the Mac shell next door (main.swift): the page and every
// operation behind it belong to the command-line lingspark shipped one directory
// up. This program starts `lingspark ui --window`, reads the address from the one
// line it prints, and shows it in a WebView2 -- the engine Edge is built on, so
// the page looks the way it looked in the Edge application window.
//
// Why there is a shell at all, when the executable itself used to be the client
// (D-074): that window belonged to Edge, so the task bar showed Edge and not
// LingSpark, and double-clicking the program also popped up a console that
// stayed open for as long as the client did. Hooks never launch this program:
// the CLI installs a copy of itself for them.
//
// Built by scripts/build-windows.mjs with the C# compiler that ships in Windows,
// so no toolchain has to be installed to package the client. The WebView2
// assemblies it compiles against come from the SDK the build downloads; the
// runtime itself is present on every Windows that has Edge, and where it is not,
// the client falls back to the Edge application window it used before.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

/// <summary>Exit codes shared with scripts/build-windows.mjs.</summary>
internal static class Shell
{
    /// <summary>The one line `lingspark ui --window` prints before anything else.</summary>
    private const string UrlMarker = "LINGSPARK_URL ";

    /// <summary>Exit code: this program is sound, and the machine has WebView2.</summary>
    private const int Ok = 0;

    /// <summary>Exit code: no WebView2 runtime here. The client still works (Edge).</summary>
    private const int NoRuntime = 3;

    /// <summary>Exit code: the command-line program is not where it should be.</summary>
    private const int NoCli = 4;

    private static Process server;
    private static WebView2 view;
    private static string origin = string.Empty;
    private static string serverError = string.Empty;

    /// <summary>The tray entry the window parks in when it leaves the screen (D-084).</summary>
    private static NotifyIcon tray;

    /// <summary>The one window, kept for the menu builders that run on poll threads.</summary>
    private static Form mainForm;

    /// <summary>
    /// The token the server handed out in the address it printed. Every API call
    /// carries it in a header, and the server rejects a call without it -- the
    /// shell is the page's own, so it may drive the same buttons (D-086).
    /// </summary>
    private static string serverToken = string.Empty;

    /// <summary>The agent rows the last /api/state answered, in the server's order.</summary>
    private static readonly List<AgentItem> agents = new List<AgentItem>();

    /// <summary>The whole-enable / whole-disable pair, enabled per latest state.</summary>
    private static ToolStripMenuItem enableAll;
    private static ToolStripMenuItem disableAll;

    /// <summary>Three-second ask for the state; null until the server answers once.</summary>
    private static System.Windows.Forms.Timer poll;

    /// <summary>One question in flight at a time; the answers come on pool threads.</summary>
    private static bool asking;

    /// <summary>Set by the tray's "退出": the cross hides instead of closing, this one does not.</summary>
    private static bool allowClose;

    /// <summary>
    /// The second instance pokes this and exits; the running one is listening on
    /// a thread and brings its window back. A window hidden to the tray cannot
    /// be brought back with ShowWindow alone -- it stays out of the task bar
    /// until its own thread says otherwise -- so the poke replaces the old
    /// process-walk-and-ShowWindow for the hidden case (D-084).
    /// </summary>
    private const string ShowSignal = @"Local\LingSpark.Client.Show";

    /// <summary>
    /// LINGSPARK_SELFTEST=&lt;png&gt; writes one picture of the page and exits (D-061).
    /// What the window shows cannot be checked any other way here: a screenshot
    /// of the desktop is taken by the window manager's own blitter, and the page
    /// is a GPU-composited layer inside it, so a capture of the screen shows an
    /// empty window where the page is (D-074). The web view's own preview is the
    /// one that has the pixels.
    ///
    /// The Mac shell hides its window for this; here the page is drawn in a child
    /// window of its own, which a transparent parent does not cover, so the
    /// window is on screen for the two seconds the shot takes. LINGSPARK_SELFTEST_JS
    /// runs a script first, for a state worth photographing (the "正在检查" light,
    /// the settings page).
    /// </summary>
    private static readonly string selfTest = Environment.GetEnvironmentVariable("LINGSPARK_SELFTEST");

    /// <summary>Set when the page is sent to the web view, so the shot waits for that one.</summary>
    private static bool selfTestArmed;

    [STAThread]
    private static int Main(string[] args)
    {
        // The build's smoke test: does this binary run, find the command-line
        // program, and get a web view out of the machine? The code says nothing
        // on stdout -- a program without a console has nowhere to say it -- so
        // the answer is the exit code.
        if (Array.IndexOf(args, "--check") >= 0) return Check();

        // Written out rather than as `out var`: the compiler that ships in
        // Windows is old enough not to know that (see scripts/build-windows.mjs).
        bool mine;
        using (var once = new Mutex(true, @"Local\LingSpark.Client", out mine))
        {
            if (!mine)
            {
                // Already open. The other window holds the web view's profile
                // directory, so a second one could not have it either; bring the
                // running window forward instead, or the double-click looks like
                // nothing happened.
                RaiseRunningWindow();
                return Ok;
            }
            Application.EnableVisualStyles();
            Form form;
            try
            {
                form = NewForm();
            }
            catch (Exception err)
            {
                // The web view's own files are not where they should be -- a
                // broken install, not a machine without the runtime. Say so
                // instead of vanishing: a program with no console that dies
                // quietly is the worst kind of broken.
                MessageBox.Show(
                    "客户端文件不完整，请重新安装。\n\n" + err.Message,
                    "LingSpark", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return NoCli;
            }
            // A second launch does not reach this instance's window directly --
            // it pokes ShowSignal and exits. Something has to listen: a thread
            // of the pool waiting on the event and hopping to the window's own.
            // The handle outlives Application.Run only if the thread is
            // background, and the form.Close in the self-test is the one close
            // this listener must not fight: it catches the race and shuts up.
            var wake = new EventWaitHandle(false, EventResetMode.AutoReset, ShowSignal);
            var listener = new Thread(delegate()
            {
                while (wake.WaitOne())
                {
                    try
                    {
                        form.BeginInvoke(new Action(delegate { RestoreFromTray(form); }));
                    }
                    catch (InvalidOperationException)
                    {
                        // The window is gone; nothing left to bring forward.
                        return;
                    }
                }
            });
            listener.IsBackground = true;
            listener.Start();
            Application.Run(form);
            return Ok;
        }
    }

    // MARK: the window

    private static Form NewForm()
    {
        var form = new Form();
        // The same size the Edge application window was given: 336x440 is the
        // page's own area, and what is left of the window is the frame and the
        // title bar, whose height is the user's setting (D-075).
        form.Text = "LingSpark · 灵光";
        form.ClientSize = new Size(336, 440);
        form.StartPosition = FormStartPosition.CenterScreen;
        // Black until the page has drawn: no white flash on opening.
        form.BackColor = Color.Black;
        // The page is one fixed card (D-075): there is nothing a bigger window
        // would show. A fixed frame does not draw the maximize button and does
        // not let the frame be dragged -- a greyed-out one is what a sizable
        // border with MaximizeBox=false leaves behind, which reads as broken
        // (D-082 tried that; D-084 settled the size for good).
        form.FormBorderStyle = FormBorderStyle.FixedSingle;
        form.MaximizeBox = false;
        // The minimize button hides the window to the tray instead, see
        // HideToTray; the old "grey it out" argument (D-082) does not apply to
        // a button that still does something.
        form.MinimizeBox = true;
        form.AutoScaleDimensions = new SizeF(96F, 96F);
        form.AutoScaleMode = AutoScaleMode.Dpi;

        // The icon in the title bar, on the task bar and in the tray is the
        // window's, not the file's: a form with no icon of its own falls back
        // to the system application icon, which is a white window in four
        // colours and looked like nothing to do with us. The star rcedit
        // stamped into the program was in there all along, in the resource
        // Explorer reads; this reads it back out for the window (D-082).
        Icon star = null;
        try
        {
            star = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (star != null) form.Icon = star;
        }
        catch (Exception)
        {
            // A program with no icon still opens, it just looks like every other
            // program -- which is what it looked like before it had one.
        }

        // The tray is where the window lives when it is not on screen (D-084):
        // closing or minimizing does not quit, it parks the window here and
        // the server keeps running. The icon is the same star; with none, the
        // entry is a blank slot but the menu still works.
        mainForm = form;
        tray = new NotifyIcon();
        if (star != null) tray.Icon = star;
        tray.Text = "LingSpark · 灵光";
        // This first menu is what a right-click answers before the server has
        // said anything; the agent rows land with the first /api/state (D-086).
        tray.ContextMenuStrip = StaticMenu(form);
        tray.DoubleClick += delegate { RestoreFromTray(form); };
        // This is the line that puts the star in the corner: a NotifyIcon is
        // born invisible, and without this it lives for the whole session
        // showing nothing -- the exact bug the first tray build shipped (D-085).
        // Visible from the start, not only when the window hides: the tray is
        // also the handle on the app when the window is already open.
        tray.Visible = true;

        // The page behind the frame is #000000, and Windows paints the title bar
        // light unless something asks it not to: the same window in two shades,
        // with the lighter one on top. Asked before the first frame goes up, so
        // there is no white bar to watch turn dark (D-082).
        form.HandleCreated += delegate { DarkenTitleBar(form); };

        view = new WebView2();
        view.Dock = DockStyle.Fill;
        form.Controls.Add(view);

        form.Shown += async delegate
        {
            var cli = FindCli();
            if (cli == null)
            {
                Fail(form, "安装包不完整：找不到命令行版 lingspark。请重新下载安装。");
                return;
            }
            try
            {
                // Probed before the server starts, so a machine without the
                // WebView2 runtime never has one started only to throw it away.
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(DataDir(), "window"));
                await view.EnsureCoreWebView2Async(env);
                var core = view.CoreWebView2;
                // This is an app, not a browser: no right-click menu, no zoom
                // control, no status bar. What the page can still open, it opens
                // in the browser, like on the Mac.
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreDefaultScriptDialogsEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
                {
                    // The page stays the page: its own address loads here, https
                    // links open in the browser, anything else goes nowhere.
                    if (e.Uri.StartsWith(origin + "/", StringComparison.OrdinalIgnoreCase)) return;
                    e.Cancel = true;
                    if (e.Uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) OpenExternally(e.Uri);
                };
                core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e)
                {
                    e.Handled = true;
                    if (e.Uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) OpenExternally(e.Uri);
                };
                core.DocumentTitleChanged += delegate { form.Text = "LingSpark · 灵光"; };
                StartServer(cli, form);
                if (selfTest != null) WatchSelfTest(core, form);
            }
            catch (Exception)
            {
                // No WebView2 runtime on this machine (Windows 10 without Edge,
                // an LTSC image). The page is still ours to show: the CLI opens it
                // in an Edge application window by itself, exactly as it did
                // before this shell existed (D-074).
                OpenInBrowserWindow(cli);
                form.Close();
            }
        };

        // "完成" on the page, or the server going away for any other reason, ends
        // the client. The other way round: the client holds the server's standard
        // input open, so however it goes -- closed, crashed, killed -- the server
        // reads end-of-input and exits (D-061).
        form.FormClosing += delegate(object sender, FormClosingEventArgs e)
        {
            // The cross parks the window in the tray instead of quitting (D-084,
            // the task-bar minimize of D-083 revised): the server keeps running
            // with no window at all, and the ways out are the page's "完成" and
            // the tray's "退出". Only a close the user asked for is intercepted --
            // the programmatic ones (the self-test closing its window, the server
            // exiting, Application.Exit) carry other CloseReason values and take
            // the normal path below.
            if (!allowClose && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray(form);
                return;
            }
            if (tray != null)
            {
                tray.Visible = false;
                tray.Dispose();
            }
            if (poll != null) poll.Stop();
            StopServer();
        };

        // The minimize button (and Win+D) leave the task bar too, not just the
        // cross: minimized or closed, the window is in the tray or nowhere.
        form.Resize += delegate
        {
            if (form.WindowState == FormWindowState.Minimized) HideToTray(form);
        };
        return form;
    }

    // MARK: the tray

    /// <summary>Window off the screen, server still running: the parked state (D-084).</summary>
    private static void HideToTray(Form form)
    {
        form.WindowState = FormWindowState.Normal;
        form.Hide();
        form.ShowInTaskbar = false;
    }

    /// <summary>The tray icon's double-click and menu, and the second launch's answer.</summary>
    private static void RestoreFromTray(Form form)
    {
        if (!form.Visible)
        {
            form.Show();
            form.ShowInTaskbar = true;
        }
        form.WindowState = FormWindowState.Normal;
        form.Activate();
    }

    // MARK: the tray menu talks to the server

    /// <summary>
    /// One agent row: the latest /api/state for it, and the menu item that
    /// shows it. The item lives and dies with the menu rebuilds.
    /// </summary>
    private sealed class AgentItem
    {
        public string Id = string.Empty;
        public string Name = string.Empty;
        public bool Present;
        public bool Installable;
        public bool Found = true;
        public bool Installed;
        public ToolStripMenuItem Item;
    }

    /// <summary>显示 / 退出: the part of the menu that never changes (D-086).</summary>
    private static ContextMenuStrip StaticMenu(Form form)
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("显示 LingSpark", null, delegate { RestoreFromTray(form); });
        menu.Items.Add("退出", null, delegate
        {
            // The one way out besides the page's "完成". Going through
            // Application.Exit lands in FormClosing with a reason that is not
            // UserClosing, so the hide-to-tray branch there is not taken.
            allowClose = true;
            Application.Exit();
        });
        return menu;
    }

    /// <summary>
    /// Asks the server for the state every few seconds and reflects it in the
    /// menu. Runs from the moment the address arrives; a failure (server still
    // starting, page busy) just means the menu stays one poll behind.
    /// </summary>
    private static void StartPolling()
    {
        if (poll != null || serverToken.Length == 0) return;
        poll = new System.Windows.Forms.Timer();
        poll.Interval = 3000;
        poll.Tick += delegate { AskState(); };
        poll.Start();
        AskState();
    }

    private static void AskState()
    {
        if (asking) return;
        asking = true;
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                var fresh = ParseAgents(Post("/api/state", "{}"));
                try
                {
                    mainForm.BeginInvoke(new Action(delegate { ApplyState(fresh); }));
                }
                catch (InvalidOperationException)
                {
                    // The window is gone; whatever the server said no longer matters.
                }
            }
            catch (Exception)
            {
                // The server did not answer this time. The menu keeps its last
                // known state, which is what "the app is running" looks like.
            }
            finally
            {
                asking = false;
            }
        });
    }

    /// <summary>Rebuilds the menu when the agent set changes, retexts it when only states did.</summary>
    private static void ApplyState(List<AgentItem> fresh)
    {
        var same = fresh.Count == agents.Count;
        if (same)
        {
            for (var i = 0; i < fresh.Count; i++)
            {
                if (fresh[i].Id != agents[i].Id) { same = false; break; }
            }
        }
        if (!same)
        {
            agents.Clear();
            agents.AddRange(fresh);
            RebuildMenu();
        }
        else
        {
            for (var i = 0; i < fresh.Count; i++)
            {
                var to = fresh[i];
                var have = agents[i];
                have.Present = to.Present;
                have.Installable = to.Installable;
                have.Found = to.Found;
                have.Installed = to.Installed;
            }
        }
        UpdateMenuTexts();
    }

    private static void RebuildMenu()
    {
        var menu = new ContextMenuStrip();
        foreach (var a in agents)
        {
            var row = a;
            a.Item = new ToolStripMenuItem();
            a.Item.Click += delegate { ToggleAgent(row); };
            menu.Items.Add(a.Item);
        }
        if (agents.Count > 0) menu.Items.Add(new ToolStripSeparator());
        enableAll = new ToolStripMenuItem("全部开启", null, delegate { Send("/api/enable-all", "{}"); });
        disableAll = new ToolStripMenuItem("全部关闭", null, delegate { Send("/api/disable-all", "{}"); });
        menu.Items.Add(enableAll);
        menu.Items.Add(disableAll);
        menu.Items.Add(new ToolStripSeparator());
        foreach (ToolStripItem keep in StaticMenu(mainForm).Items) menu.Items.Add(keep);
        tray.ContextMenuStrip = menu;
    }

    private static void UpdateMenuTexts()
    {
        var on = 0;
        var canOn = false;
        var canOff = false;
        foreach (var a in agents)
        {
            if (a.Installed) on++;
            if (!a.Installed && a.Present && a.Installable) canOn = true;
            if (a.Installed) canOff = true;
            // The page's own legend (D-081), condensed to one tray line: what
            // the switch would say, plus what the red light next to it means.
            var mark = a.Installed ? "✓" : "○";
            string note;
            if (a.Installed) note = a.Found ? "已开启" : "已开启（未找到程序）";
            else if (!a.Present && !a.Installable) note = "暂不支持";
            else if (!a.Present) note = "未接入";
            else note = "已关闭";
            a.Item.Text = mark + " " + a.Name + "　" + note;
            a.Item.Enabled = a.Installed || a.Installable;
        }
        if (enableAll != null) enableAll.Enabled = canOn;
        if (disableAll != null) disableAll.Enabled = canOff;
        if (tray != null) tray.Text = "LingSpark · 灵光　已开启 " + on + "/" + agents.Count + " 个 agent";
    }

    /// <summary>A row click: the same /api/agent call the page's own switch makes.</summary>
    private static void ToggleAgent(AgentItem a)
    {
        var id = a.Id;
        var on = !a.Installed;
        Send("/api/agent", "{\"id\":\"" + id + "\",\"on\":" + (on ? "true" : "false") + "}");
    }

    /// <summary>Fires an API call without waiting for the answer; the next poll shows the result.</summary>
    private static void Send(string route, string body)
    {
        ThreadPool.QueueUserWorkItem(delegate
        {
            try { Post(route, body); }
            catch (Exception)
            {
                // The server is gone or busy; the menu will say so on its own.
            }
        });
    }

    /// <summary>One POST with the token header, the shape every API route takes.</summary>
    private static string Post(string route, string body)
    {
        var req = (HttpWebRequest)WebRequest.Create(origin + route);
        req.Method = "POST";
        req.ContentType = "application/json; charset=utf-8";
        req.Headers["x-lingspark-token"] = serverToken;
        req.Timeout = 4000;
        var bytes = Encoding.UTF8.GetBytes(body);
        using (var stream = req.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
        using (var resp = (HttpWebResponse)req.GetResponse())
        using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
        {
            return reader.ReadToEnd();
        }
    }

    /// <summary>The agents array of an /api/state body, nothing else read (D-086).</summary>
    private static List<AgentItem> ParseAgents(string json)
    {
        var root = ParseJson(json) as Dictionary<string, object>;
        var list = root != null ? root["agents"] as List<object> : null;
        var fresh = new List<AgentItem>();
        if (list == null) return fresh;
        foreach (var entry in list)
        {
            var d = entry as Dictionary<string, object>;
            if (d == null) continue;
            var a = new AgentItem();
            a.Id = d.ContainsKey("id") ? d["id"] as string ?? string.Empty : string.Empty;
            a.Name = d.ContainsKey("name") ? d["name"] as string ?? a.Id : a.Id;
            a.Present = BoolOf(d, "present");
            a.Installable = BoolOf(d, "installable");
            // Missing means the server had nothing to say: the page treats
            // that as found (a.found === false is the red-light case).
            a.Found = !d.ContainsKey("found") || BoolOf(d, "found");
            a.Installed = BoolOf(d, "installed");
            if (a.Id.Length > 0) fresh.Add(a);
        }
        return fresh;
    }

    private static bool BoolOf(Dictionary<string, object> d, string key)
    {
        return d.ContainsKey(key) && d[key] is bool ? (bool)d[key] : false;
    }

    /// <summary>
    /// The smallest JSON reader that answers this one question. The server
    /// writes compact objects; a full library would be a dependency the build
    /// has to fetch and pin, for a document the shape of which is ours.
    /// </summary>
    private static object ParseJson(string s)
    {
        return new Json(s).Root();
    }

    /// <summary>Cursor over one JSON document; values come back as Dictionary/List/string/bool/double.</summary>
    private sealed class Json
    {
        private readonly string s;
        private int at;

        public Json(string source)
        {
            s = source;
        }

        public object Root()
        {
            return Value();
        }

        private void Skip()
        {
            while (at < s.Length && " \t\r\n".IndexOf(s[at]) >= 0) at++;
        }

        private object Value()
        {
            Skip();
            if (at >= s.Length) return null;
            var c = s[at];
            if (c == '{') return Object();
            if (c == '[') return Array();
            if (c == '"') return String();
            if (c == 't') { at += 4; return true; }
            if (c == 'f') { at += 5; return false; }
            if (c == 'n') { at += 4; return null; }
            return Number();
        }

        private Dictionary<string, object> Object()
        {
            var d = new Dictionary<string, object>();
            at++;
            Skip();
            if (at < s.Length && s[at] == '}') { at++; return d; }
            while (at < s.Length)
            {
                var key = (string)Value();
                Skip();
                at++; // the colon
                d[key] = Value();
                Skip();
                if (at < s.Length && s[at] == ',') { at++; continue; }
                break;
            }
            at++; // the closing brace
            return d;
        }

        private List<object> Array()
        {
            var list = new List<object>();
            at++;
            Skip();
            if (at < s.Length && s[at] == ']') { at++; return list; }
            while (at < s.Length)
            {
                list.Add(Value());
                Skip();
                if (at < s.Length && s[at] == ',') { at++; continue; }
                break;
            }
            at++; // the closing bracket
            return list;
        }

        private string String()
        {
            at++; // the opening quote
            var b = new StringBuilder();
            while (at < s.Length)
            {
                var c = s[at++];
                if (c == '"') break;
                if (c == '\\' && at < s.Length)
                {
                    var e = s[at++];
                    if (e == 'u' && at + 4 <= s.Length)
                    {
                        b.Append((char)Convert.ToInt32(s.Substring(at, 4), 16));
                        at += 4;
                    }
                    else
                    {
                        b.Append(e == 'n' ? '\n' : e == 't' ? '\t' : e);
                    }
                }
                else b.Append(c);
            }
            return b.ToString();
        }

        private double Number()
        {
            var start = at;
            while (at < s.Length && "-0123456789.eE+".IndexOf(s[at]) >= 0) at++;
            return double.Parse(s.Substring(start, at - start), System.Globalization.CultureInfo.InvariantCulture);
        }
    }

    // MARK: self-test

    private static void WatchSelfTest(CoreWebView2 core, Form form)
    {
        core.NavigationCompleted += async delegate(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            // Only the page, not the empty document the control starts on: the
            // handler is attached before there is an address to navigate to, and
            // that first navigation finishes long before the server answers.
            if (!selfTestArmed || !e.IsSuccess) return;
            selfTestArmed = false;
            var script = Environment.GetEnvironmentVariable("LINGSPARK_SELFTEST_JS");
            if (!string.IsNullOrEmpty(script)) await Task.Delay(1000);
            if (!string.IsNullOrEmpty(script)) await core.ExecuteScriptAsync(script);
            // Long enough for the page's own entrance to finish drawing.
            await Task.Delay(1500);
            try
            {
                var probe = await core.ExecuteScriptAsync(
                    "document.body.className + ' | ' + document.body.innerText.replace(/\\s+/g, ' ').slice(0, 120)");
                Console.Error.WriteLine("page: " + probe);
                using (var shot = File.Create(selfTest))
                {
                    await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, shot);
                }
                Console.Error.WriteLine("wrote " + selfTest);
            }
            catch (Exception err)
            {
                Console.Error.WriteLine("self-test failed: " + err.Message);
            }
            form.Close();
        };
    }

    // MARK: the server

    private static void StartServer(string cli, Form form)
    {
        try
        {
            server = new Process();
            server.StartInfo = new ProcessStartInfo(cli, "ui --window")
            {
                UseShellExecute = false,
                // No console for a program that has none, and a window that is
                // never asked for.
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            };
            server.EnableRaisingEvents = true;
            server.Exited += delegate
            {
                try
                {
                    if (form.IsHandleCreated)
                    {
                        form.BeginInvoke(new Action(delegate { Application.Exit(); }));
                    }
                }
                catch (InvalidOperationException)
                {
                    // The window is already on its way out; nothing to close.
                }
            };
            server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { OnServerLine(e.Data); };
            server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (!string.IsNullOrEmpty(e.Data)) serverError = e.Data.Trim();
            };
            server.Start();
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();
        }
        catch (Exception err)
        {
            Fail(form, "启动失败：" + err.Message);
        }
    }

    /// <summary>The address arrives on one line; the window shows it and nothing else does.</summary>
    private static void OnServerLine(string line)
    {
        if (line == null || !line.StartsWith(UrlMarker, StringComparison.Ordinal)) return;
        var url = line.Substring(UrlMarker.Length).Trim();
        if (url.Length == 0) return;
        Uri parsed;
        if (!Uri.TryCreate(url, UriKind.Absolute, out parsed)) return;
        origin = parsed.GetLeftPart(UriPartial.Authority);
        // The same line carries the token every API call needs (D-086). It is a
        // query parameter, not part of the origin the navigation filter checks.
        var token = Regex.Match(parsed.Query, @"(?:\?|&)t=([^&]+)");
        if (token.Success) serverToken = token.Groups[1].Value;
        // `window=1` is how the page knows it is in a window: the Mac shell says
        // so in its user agent, and a window with a title bar of its own has to
        // be told here, so the page does not draw a second header (D-075). The
        // server reads only its own parameter, so the rest is ignored (D-074).
        var address = origin + "/" + (parsed.Query.Length > 0 ? parsed.Query + "&window=1" : "?window=1");
        // This arrives on a thread of the pool, and the web view only answers
        // calls made on the thread that made it: handed the address directly it
        // throws, and the window stays black with nothing said. Hop to the thread
        // the window lives on.
        var control = view;
        if (control == null || !control.IsHandleCreated) return;
        selfTestArmed = selfTest != null;
        try
        {
            control.BeginInvoke(new Action(delegate
            {
                try
                {
                    control.CoreWebView2.Navigate(address);
                    StartPolling();
                }
                catch (Exception err)
                {
                    // The window closed between the line arriving and the
                    // navigation, or the page could not be opened at all.
                    Console.Error.WriteLine("navigate failed: " + err.Message);
                }
            }));
        }
        catch (InvalidOperationException)
        {
            // Same: the window is on its way out.
        }
    }

    private static void StopServer()
    {
        if (server == null) return;
        try
        {
            if (!server.HasExited)
            {
                server.StandardInput.Close();
                // The server ends on end-of-input; this is only here for the case
                // where it does not, so the client never leaves it behind.
                if (!server.WaitForExit(3000)) server.Kill();
            }
        }
        catch (Exception)
        {
            // Already gone, or already gone from under us. Either way there is
            // nothing to close.
        }
        finally
        {
            server.Dispose();
            server = null;
        }
    }

    /// <summary>Without the runtime the CLI opens the page itself, in Edge (D-074).</summary>
    private static void OpenInBrowserWindow(string cli)
    {
        try
        {
            Process.Start(new ProcessStartInfo(cli, "ui")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            });
        }
        catch (Exception)
        {
            // Nothing left to try: the client is about to close and the page was
            // never shown. `lingspark ui` in a terminal still opens it.
        }
    }

    // MARK: paths

    /// <summary>
    /// The command-line program, one directory up: the client is a window, the
    /// program beside it is the CLI that installs the hooks and runs the checks.
    /// LINGSPARK_CLI is for running the shell out of the build tree.
    ///
    /// Only the parent directory is looked in, and *that* is why the client
    /// lives in a subdirectory of its own: "LingSpark.exe" and "lingspark.exe"
    /// are the same name on a Windows disk, so a client that sat next to the CLI
    /// would find itself first and start itself as its own server.
    /// </summary>
    private static string FindCli()
    {
        var given = Environment.GetEnvironmentVariable("LINGSPARK_CLI");
        if (!string.IsNullOrEmpty(given) && File.Exists(given)) return given;
        var here = Path.GetDirectoryName(Application.ExecutablePath) ?? string.Empty;
        var full = Path.GetFullPath(Path.Combine(here, "..", "lingspark.exe"));
        return File.Exists(full) ? full : null;
    }

    /// <summary>
    /// The web view's own profile, next to the CLI's data directory (D-061). The
    /// override is the one the tests use, and the one that keeps a dev run off
    /// the real settings.
    /// </summary>
    private static string DataDir()
    {
        var given = Environment.GetEnvironmentVariable("LINGSPARK_DATA_DIR");
        if (!string.IsNullOrEmpty(given)) return Path.GetFullPath(given);
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "lingspark");
    }

    // MARK: small things

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    /// <summary>
    /// Paints the window's own title bar in the dark the page is drawn in, so
    /// the frame stops being a light strip bolted onto a black window (D-082).
    ///
    /// The switch is attribute 20 from Windows 10 2004 on, and 19 on the
    /// 1809-1903 builds, which answer to nothing else: both are tried, newest
    /// first, and a build that knows neither keeps the title bar it came with.
    /// </summary>
    private static void DarkenTitleBar(Form form)
    {
        try
        {
            var window = form.Handle;
            var dark = 1;
            if (DwmSetWindowAttribute(window, 20, ref dark, 4) != 0) DwmSetWindowAttribute(window, 19, ref dark, 4);
            // The switch alone only makes the caption dark grey. Windows 11 can
            // be told which colour it is, and the page behind it is #000000, so
            // the bar is painted that same black: window and page as one
            // surface, the buttons floating on it. The border is left as Windows
            // draws it -- a black edge around a window is a window with no edge
            // at all on any desktop that is not itself black.
            var black = 0;
            DwmSetWindowAttribute(window, 35, ref black, 4);
        }
        catch (Exception)
        {
            // No dwmapi, or no desktop window manager at all (composition turned
            // off). The window is still a window.
        }
    }

    private static void OpenExternally(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception)
        {
            // The browser did not open it. The page is ours to show, not to fix.
        }
    }

    private static void Fail(Form form, string message)
    {
        try
        {
            if (form.IsHandleCreated)
            {
                form.BeginInvoke(new Action(delegate
                {
                    MessageBox.Show(message + (serverError.Length > 0 ? "\n\n" + serverError : string.Empty),
                        "LingSpark", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Application.Exit();
                }));
                return;
            }
        }
        catch (InvalidOperationException)
        {
            // Already closing.
        }
        MessageBox.Show(message, "LingSpark", MessageBoxButtons.OK, MessageBoxIcon.Error);
        Application.Exit();
    }

    /// <summary>Same as the build's own check, without the window: see Main.</summary>
    private static int Check()
    {
        if (FindCli() == null) return NoCli;
        try
        {
            var task = CoreWebView2Environment.CreateAsync(null, Path.Combine(DataDir(), "window"));
            task.Wait(30000);
            if (task.IsFaulted) return NoRuntime;
            return task.Result == null ? NoRuntime : Ok;
        }
        catch (Exception)
        {
            return NoRuntime;
        }
    }

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int how);

    private static void RaiseRunningWindow()
    {
        try
        {
            // The main road: the running instance is waiting on ShowSignal and
            // restores its own window -- which matters because a window hidden
            // to the tray has no task-bar entry and a bare ShowWindow from here
            // would bring back a window that still has none (D-084).
            EventWaitHandle.OpenExisting(ShowSignal).Set();
        }
        catch (Exception)
        {
            // No listener (an old build still running, say). Fall through to
            // the plain ShowWindow; a visible window answers to that.
        }
        try
        {
            var self = Process.GetCurrentProcess();
            foreach (var other in Process.GetProcessesByName(self.ProcessName))
            {
                using (other)
                {
                    if (other.Id == self.Id || other.MainWindowHandle == IntPtr.Zero) continue;
                    ShowWindow(other.MainWindowHandle, 9);
                    SetForegroundWindow(other.MainWindowHandle);
                    return;
                }
            }
        }
        catch (Exception)
        {
            // The other window is not reachable; this one stays out of the way.
        }
    }
}
