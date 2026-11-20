using System;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Forms = System.Windows.Forms;

internal static class Program
{
    private const string Origin = "http://127.0.0.1:8792";
    private const string AssetHost = "pc-control-plane.invalid";
    private const string AssetOrigin = "https://" + AssetHost;
    private static readonly bool Smoke = Array.Exists(Environment.GetCommandLineArgs(), arg => arg == "--offline-smoke");
    private static readonly bool Offline = Smoke || Array.Exists(Environment.GetCommandLineArgs(), arg => arg == "--offline-preview");
    private static readonly (string Name, string Uri)[] Settings =
    {
        ("Power", "ms-settings:powersleep"), ("Display", "ms-settings:display"), ("Night Light", "ms-settings:nightlight"),
        ("Sound", "ms-settings:sound"), ("Network", "ms-settings:network-status"),
        ("Startup apps", "ms-settings:startupapps"), ("Windows Update", "ms-settings:windowsupdate")
    };

    [STAThread]
    private static void Main()
    {
        var args = Environment.GetCommandLineArgs();
        if (args is [_, "--service-registration-check"])
        {
            var status = EngineWindowsService.ReadRegistrationStatus();
            Console.WriteLine(status);
            Environment.ExitCode = status == "Unavailable" ? 1 : 0;
            return;
        }
        if (args is [_, "--windows-service-qualification", var dataDirectory, var ownershipDirectory])
        {
            using var service = new EngineWindowsService(dataDirectory, ownershipDirectory);
            System.ServiceProcess.ServiceBase.Run(service);
            Environment.ExitCode = service.ExitCode;
            return;
        }
        if (args is [_, "--update-recheck-check"])
        {
            try
            {
                var missing = new UpdateStatus.SoftwareUpdate(Guid.NewGuid(), 1, "", false, false, false, -1);
                var available = UpdateStatus.ReadSoftware(false).FirstOrDefault();
                var installed = UpdateStatus.ReadInstalledSoftware().FirstOrDefault();
                if (UpdateStatus.Recheck(missing) is not null || UpdateStatus.Recheck(missing, installed: true) is not null ||
                    (available is not null && (UpdateStatus.Recheck(available)?.Revision != available.Revision ||
                        UpdateStatus.Recheck(available, installed: true) is not null)) ||
                    (installed is not null && (UpdateStatus.Recheck(installed, installed: true) is null ||
                        UpdateStatus.Recheck(installed) is not null)))
                    Environment.ExitCode = 1;
                else Console.WriteLine($"Missing revision verified. Available fixture: {available is not null}. Installed fixture: {installed is not null}.");
            }
            catch { Environment.ExitCode = 1; }
            return;
        }
        if (args is [_, "--cached-updates-check" or "--online-updates-check"])
        {
            try { Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(UpdateStatus.ReadSoftware(args[1] == "--online-updates-check"))); }
            catch { Environment.ExitCode = 1; }
            return;
        }
        if (args is [_, "--update-status-check"])
        {
            try { Console.WriteLine(UpdateStatus.ReadRestartRequired()); }
            catch { Environment.ExitCode = 1; }
            return;
        }
        if (args is [_, "--device-inventory-check"])
        {
            try
            {
                var devices = ServiceInventory.ReadDevicesAsync().GetAwaiter().GetResult();
                Environment.ExitCode = devices.Any(device => !string.IsNullOrWhiteSpace(device.Name) && device.Problem == 0) ? 0 : 1;
            }
            catch { Environment.ExitCode = 1; }
            return;
        }
        if (args is [_, "--service-inventory-check"])
        {
            try { Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(ServiceInventory.ReadAsync().GetAwaiter().GetResult())); }
            catch { Environment.ExitCode = 1; }
            return;
        }
        if (args is [_, "--bundled-engine-check"])
        {
            try { EngineSupervisor.CheckBundleAsync(AppContext.BaseDirectory).GetAwaiter().GetResult(); }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                Environment.ExitCode = 1;
            }
            return;
        }
        if (Array.Exists(args, arg => arg == "--power-readback-check"))
        {
            var active = PowerReadback.Read();
            if (active is { } plan) Console.WriteLine(plan.Id);
            else Environment.ExitCode = 1;
            return;
        }
        if (Array.Exists(args, arg => arg == "--startup-inventory-check"))
        {
            Console.WriteLine(StartupInventory.Read());
            return;
        }
        if (Array.Exists(args, arg => arg is "--worker-preview" or "--worker-smoke"))
        {
            try
            {
                if (Array.Exists(args, arg => arg == "--worker-smoke"))
                    WorkerPipe.SmokeAsync().GetAwaiter().GetResult();
                else WorkerPipe.RunAsync(CancellationToken.None).GetAwaiter().GetResult();
            }
            catch (Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 1; }
            return;
        }
        if (Smoke)
        {
            var smokeApp = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
            var smokeWindow = CreateWindow();
            var timeout = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(25) };
            timeout.Tick += (_, _) => smokeApp.Shutdown(2);
            timeout.Start();
            smokeApp.Run(smokeWindow);
            timeout.Stop();
            return;
        }
        using var instance = new Mutex(true, @"Local\PCControlPlane.DesktopPreview", out var first);
        if (!first) { MessageBox.Show("Open PC Control Plane from the notification area."); return; }
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        using var tray = new Forms.NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Application,
            Text = "PC Control Plane preview",
            ContextMenuStrip = new Forms.ContextMenuStrip()
        };
        Window? window = null;
        void Open()
        {
            if (window != null)
            {
                if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Normal;
                window.Activate();
                return;
            }
            window = CreateWindow();
            window.Closed += (_, _) => window = null;
            window.Show();
        }
        tray.ContextMenuStrip.Items.Add("Open PC Control Plane", null, (_, _) => Open());
        var statusItem = tray.ContextMenuStrip.Items.Add("Check engine status");
        statusItem.Click += async (_, _) =>
        {
            statusItem.Enabled = false;
            string result = await ReadInstalledEngineAsync();
            if (!Offline)
            {
                string legacy;
                try { legacy = await AuditExport.ReadEngineStatusAsync(new Uri(Origin)); }
                catch { legacy = "Engine status unavailable."; }
                result += $"\nLegacy browser engine: {legacy}";
            }
            var plan = PowerReadback.Read();
            result += "\nActive Windows plan: " + (plan?.Name ?? "unavailable") + ".";
            if (app.Dispatcher.HasShutdownStarted) return;
            statusItem.Enabled = true;
            tray.ShowBalloonTip(4000, "PC Control Plane", result, Forms.ToolTipIcon.Info);
        };
        tray.ContextMenuStrip.Items.Add("Exit desktop preview", null, (_, _) => { window?.Close(); app.Shutdown(); });
        tray.DoubleClick += (_, _) => Open();
        using var workerStop = new CancellationTokenSource();
        var worker = System.Threading.Tasks.Task.Run(() => WorkerPipe.RunAsync(workerStop.Token));
        try
        {
            tray.Visible = true;
            Open();
            app.Run();
        }
        finally
        {
            tray.Visible = false;
            workerStop.Cancel();
            try { worker.GetAwaiter().GetResult(); }
            catch (OperationCanceledException) when (workerStop.IsCancellationRequested) { }
            catch (Exception error) { Console.Error.WriteLine(error.Message); }
        }
    }

    private static Window CreateWindow()
    {
        var window = new Window { Title = "PC Control Plane", Width = 1220, Height = 800, MinWidth = 640, MinHeight = 460 };
        var root = new DockPanel();
        var nav = new StackPanel { Width = 172, Margin = new Thickness(12) };
        DockPanel.SetDock(nav, Dock.Left);
        root.Children.Add(nav);
        var body = new ContentControl();
        root.Children.Add(body);
        window.Content = root;
        WebView2? web = null;
        int generation = 0;
        bool bundleCheckRunning = false;
        bool updateSearchRunning = false;
        void DisposeView() { generation++; web?.Dispose(); web = null; }
        window.Closed += (_, _) => DisposeView();
        void Native(string title, string status, bool links = false)
        {
            DisposeView();
            var content = new StackPanel { Margin = new Thickness(24) };
            content.Children.Add(new TextBlock { Text = title, FontSize = 26, Margin = new Thickness(0, 0, 0, 12) });
            content.Children.Add(new TextBlock { Text = status, TextWrapping = TextWrapping.Wrap, FontSize = 15 });
            if (links)
                foreach (var (name, uri) in Settings)
                    AddButton(content, name + " settings", () =>
                    {
                        try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); }
                        catch { MessageBox.Show("Windows could not open this Settings page."); }
                    });
            if (title == "Admin Toolkit")
            {
                async void SearchUpdates(bool online)
                {
                    var title = online ? "Software updates" : "Cached software updates";
                    if (updateSearchRunning || UpdateStatus.SearchRunning)
                    {
                        MessageBox.Show(window, "A Windows Update search is already running.");
                        return;
                    }
                    if (online && MessageBox.Show(window, "Check online for software updates? Nothing will be installed or restarted.",
                        "Windows Update", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK)
                        return;
                    Native(title, online ? "Checking for software updates..." : "Reading the local Windows Update catalog...");
                    int version = generation;
                    string status;
                    updateSearchRunning = true;
                    try
                    {
                        var updates = await System.Threading.Tasks.Task.Run(() => UpdateStatus.ReadSoftware(online));
                        if (version != generation) return;
                        status = online ? "No matching software updates found." : "No software updates listed in the cache.";
                        if (updates.Length > 0)
                        {
                            var panel = new DockPanel { Margin = new Thickness(24) };
                            var header = new StackPanel();
                            DockPanel.SetDock(header, Dock.Top);
                            panel.Children.Add(header);
                            header.Children.Add(new TextBlock { Text = title, FontSize = 26 });
                            header.Children.Add(new TextBlock { TextWrapping = TextWrapping.Wrap,
                                Text = online ? "Configured Windows Update source" : "Local catalog. Results may be out of date." });
                            var list = new ListBox { ItemsSource = updates, DisplayMemberPath = "Title" };
                            System.Windows.Automation.AutomationProperties.SetName(list, "Software updates");
                            var detail = new TextBlock { TextWrapping = TextWrapping.Wrap };
                            var recheck = new Button { Content = "Recheck selected update", MinHeight = 40, IsEnabled = false };
                            header.Children.Add(recheck);
                            AddButton(header, "Open Windows Update settings", () =>
                            {
                                try { Process.Start(new ProcessStartInfo("ms-settings:windowsupdate") { UseShellExecute = true }); }
                                catch { MessageBox.Show(window, "Windows Update settings could not be opened."); }
                            });
                            header.Children.Add(detail);
                            panel.Children.Add(list);
                            list.SelectionChanged += (_, _) =>
                            {
                                recheck.IsEnabled = list.SelectedItem is UpdateStatus.SoftwareUpdate;
                                detail.Text = list.SelectedItem is UpdateStatus.SoftwareUpdate item
                                    ? $"Revision {item.Revision}. {item.Readiness}\n{item.RestartNotice}"
                                    : "";
                            };
                            recheck.Click += async (_, _) =>
                            {
                                if (list.SelectedItem is not UpdateStatus.SoftwareUpdate selected) return;
                                list.IsEnabled = recheck.IsEnabled = false;
                                detail.Text = "Rechecking the local catalog...";
                                try
                                {
                                    var (current, installed) = await System.Threading.Tasks.Task.Run(() =>
                                    {
                                        var available = UpdateStatus.Recheck(selected);
                                        return (available, available is null && UpdateStatus.Recheck(selected, installed: true) is not null);
                                    });
                                    detail.Text = installed ? "Windows lists this exact revision as installed."
                                        : current is null ? "Windows does not list this revision as available or installed in the local catalog. Refresh the update list."
                                        : $"Exact revision confirmed in the local catalog.\n{current.RestartNotice}\n" +
                                            (await System.Threading.Tasks.Task.Run(() =>
                                            {
                                                var reason = current.InstallBlockReason(false);
                                                if (reason is not null) return reason;
                                                bool? pending;
                                                try { pending = UpdateStatus.ReadRestartRequired(); }
                                                catch { pending = null; }
                                                return current.InstallBlockReason(pending);
                                            }) ?? "Preflight passed. Installation is not enabled in this preview.");
                                }
                                catch { detail.Text = "Could not verify this revision."; }
                                finally { list.IsEnabled = recheck.IsEnabled = true; }
                            };
                            body.Content = panel;
                            return;
                        }
                    }
                    catch { status = "Windows did not return a complete update list. Open Windows Update settings for details."; }
                    finally { updateSearchRunning = false; }
                    if (version == generation) Native(title, status, true);
                }
                AddButton(content, "View cached software updates", () => SearchUpdates(false));
                AddButton(content, "Check for software updates online", () => SearchUpdates(true));
                AddButton(content, "Check update restart status", async () =>
                {
                    Native("Windows Update status", "Reading restart status...");
                    int version = generation;
                    string status;
                    try
                    {
                        status = await System.Threading.Tasks.Task.Run(UpdateStatus.ReadRestartRequired)
                            ? "Windows Update requires a restart to finish a previous change."
                            : "Windows Update does not report a pending restart.";
                    }
                    catch { status = "Windows Update restart status is unavailable."; }
                    if (version == generation) Native("Windows Update status", status, true);
                });
                AddButton(content, "View Windows services", async () =>
                {
                    Native("Windows services", "Reading service state and dependencies...");
                    int version = generation;
                    ServiceInventory.ServiceRow[] services;
                    try { services = await ServiceInventory.ReadAsync(); }
                    catch
                    {
                        if (version == generation) Native("Windows services", "Windows service information is unavailable.");
                        return;
                    }
                    if (version != generation) return;
                    var panel = new DockPanel { Margin = new Thickness(24) };
                    var header = new StackPanel { Margin = new Thickness(0, 0, 0, 12) };
                    DockPanel.SetDock(header, Dock.Top);
                    panel.Children.Add(header);
                    header.Children.Add(new TextBlock { Text = "Windows services", FontSize = 26 });
                    var filter = new TextBox { MinHeight = 40 };
                    header.Children.Add(new Label { Content = "Search services", Target = filter });
                    header.Children.Add(filter);
                    var count = new TextBlock { Margin = new Thickness(0, 8, 0, 0) };
                    header.Children.Add(count);
                    var table = new DataGrid { IsReadOnly = true, AutoGenerateColumns = false, CanUserAddRows = false };
                    foreach (var (label, property) in new[]
                    {
                        ("Service", "DisplayName"), ("Name", "Name"), ("State", "State"),
                        ("Startup", "Startup"), ("Depends on", "Dependencies"), ("Required by", "Dependents")
                    })
                        table.Columns.Add(new DataGridTextColumn { Header = label, Binding = new System.Windows.Data.Binding(property) });
                    panel.Children.Add(table);
                    void Filter()
                    {
                        var query = filter.Text.Trim();
                        var rows = services.Where(row => row.Name.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                            row.DisplayName.Contains(query, StringComparison.OrdinalIgnoreCase)).ToArray();
                        table.ItemsSource = rows;
                        count.Text = rows.Length == 0 ? "No matching services." : $"{rows.Length} services";
                    }
                    filter.TextChanged += (_, _) => Filter();
                    Filter();
                    body.Content = panel;
                });
                AddButton(content, "View connected devices", async () =>
                {
                    Native("Connected devices", "Reading Windows device status...");
                    int version = generation;
                    try
                    {
                        var devices = await ServiceInventory.ReadDevicesAsync();
                        if (version != generation) return;
                        body.Content = new DataGrid
                        {
                            Margin = new Thickness(24), IsReadOnly = true, CanUserAddRows = false,
                            ItemsSource = devices.OrderByDescending(device => device.Problem is > 0).Select(device => new
                            {
                                Device = device.Name ?? "Unnamed device",
                                Category = device.Class ?? "Not reported",
                                Status = device.Status ?? "Not reported",
                                Problem = device.Problem switch { 0 => "None reported", null => "Not reported", _ => $"Windows code {device.Problem}" }
                            }).ToArray()
                        };
                    }
                    catch
                    {
                        if (version == generation) Native("Connected devices", "Windows device information is unavailable.");
                    }
                });
                AddButton(content, "View startup registrations", () =>
                    Native("Startup registrations", "Registry Run entries only. An entry here does not mean Windows has enabled it.\n\n" + StartupInventory.Read(), true));
                AddButton(content, "Read active power plan", () =>
                {
                    var active = PowerReadback.Read();
                    Native("Active Windows power plan", active is { } plan
                        ? $"{plan.Name ?? "Plan name unavailable"}\nPlan ID: {plan.Id}"
                        : "Windows did not report an active power plan.", true);
                });
            }
            if (title == "Worker status" && System.IO.File.Exists(System.IO.Path.Combine(AppContext.BaseDirectory, "engine", "node.exe")))
                AddButton(content, "Check bundled engine", async () =>
                {
                    if (bundleCheckRunning) return;
                    bundleCheckRunning = true;
                    Native("Bundled engine check", "Checking startup, health, and shutdown...");
                    int version = generation;
                    string result;
                    try
                    {
                        await EngineSupervisor.CheckBundleAsync(AppContext.BaseDirectory);
                        result = "The bundled engine started, answered its health check, and shut down cleanly.";
                    }
                    catch { result = "The bundled engine check did not pass. Your running installation was not changed."; }
                    finally { bundleCheckRunning = false; }
                    if (version == generation) Native("Bundled engine check", result);
                });
            body.Content = new ScrollViewer { Content = content };
        }
        async void Browse(string route)
        {
            DisposeView();
            var version = generation;
            var view = new WebView2();
            web = view;
            body.Content = view;
            try
            {
                var profile = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PCControlPlane", Smoke ? "SmokeWebView" : Offline ? "OfflineWebView" : "PreviewWebView");
                await view.EnsureCoreWebView2Async(await CoreWebView2Environment.CreateAsync(userDataFolder: profile));
                if (version != generation) return;
                var core = view.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsWebMessageEnabled = false;
                core.Settings.AreHostObjectsAllowed = false;
                if (Offline)
                    core.SetVirtualHostNameToFolderMapping(AssetHost, System.IO.Path.Combine(AppContext.BaseDirectory, "public"), CoreWebView2HostResourceAccessKind.Deny);
                core.NavigationStarting += (_, e) =>
                {
                    if (e.Uri == "ms-settings:nightlight")
                    {
                        e.Cancel = true;
                        if (e.IsUserInitiated &&
                            Uri.TryCreate(core.Source, UriKind.Absolute, out var source) &&
                            (Offline ? Packaged(core.Source) : Local(core.Source)) &&
                            source.AbsolutePath == "/comfort.html")
                        {
                            try { Process.Start(new ProcessStartInfo("ms-settings:nightlight") { UseShellExecute = true }); }
                            catch { MessageBox.Show("Windows could not open Night Light settings."); }
                        }
                        return;
                    }
                    e.Cancel = !(Offline ? Packaged(e.Uri) : Local(e.Uri));
                    if (!Offline || e.Cancel) return;
                    var uri = new Uri(e.Uri);
                    var page = PageFile(uri.AbsolutePath);
                    if (page != uri.AbsolutePath)
                    {
                        e.Cancel = true;
                        core.Navigate(AssetOrigin + page + uri.Query + uri.Fragment);
                    }
                };
                core.NewWindowRequested += (_, e) => e.Handled = true;
                core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
                core.DownloadStarting += (_, e) => e.Cancel = true;
                core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
                core.WebResourceRequested += (_, e) =>
                {
                    if (Offline && Packaged(e.Request.Uri) && new Uri(e.Request.Uri).AbsolutePath.StartsWith("/api/", StringComparison.Ordinal))
                    {
                        var content = new System.IO.MemoryStream(System.Text.Encoding.UTF8.GetBytes(
                            "{\"ok\":false,\"message\":\"Offline preview: the desktop engine is not connected.\"}"));
                        e.Response = core.Environment.CreateWebResourceResponse(content, 503, "Unavailable", "Content-Type: application/json\r\nCache-Control: no-store");
                        return;
                    }
                    if (!(Offline ? Packaged(e.Request.Uri) : Local(e.Request.Uri)) || e.Request.Method != "GET" ||
                        new Uri(e.Request.Uri).AbsolutePath == "/api/stream")
                        e.Response = core.Environment.CreateWebResourceResponse(null, 403, "Read-only desktop preview", "");
                };
                core.NavigationCompleted += (_, e) =>
                {
                    if (!e.IsSuccess && version == generation)
                        Native("View unavailable", Offline ? "Check that the packaged view files are present." : "Start the existing PC Control Plane, then select a view again.");
                };
                if (Smoke)
                {
                    string[] pages = ["/index.html", "/lab.html", "/comfort.html"];
                    int step = 0;
                    core.NavigationCompleted += async (_, e) =>
                    {
                        try
                        {
                            if (!e.IsSuccess || new Uri(core.Source).AbsolutePath != pages[step])
                                throw new InvalidOperationException($"Navigation {step}: {e.WebErrorStatus} ({core.Source})");
                            await core.ExecuteScriptAsync("""
                                (async () => {
                                    let ok = !!document.querySelector('main, h1');
                                    try {
                                        const { createControlClient } = await import('/control-client.js');
                                        try {
                                            await createControlClient({fetcher: () => { throw new Error('Unexpected transport'); }})('/api/status');
                                            ok = false;
                                        } catch (error) { ok = ok && error.status === 503 && !error.uncertain; }
                                        document.documentElement.dataset.smoke = ok ? 'pass' : 'unexpected control result';
                                    } catch (error) { document.documentElement.dataset.smoke = String(error); }
                                })()
                                """);
                            string result = "null";
                            for (int poll = 0; poll < 40 && result == "null"; poll++)
                            {
                                await System.Threading.Tasks.Task.Delay(50);
                                result = await core.ExecuteScriptAsync("document.documentElement.dataset.smoke ?? null");
                            }
                            if (result != "\"pass\"") throw new InvalidOperationException($"Page {step}: {result}");
                            Console.WriteLine($"Passed {pages[step]}");
                            if (++step == pages.Length) Application.Current.Shutdown(0);
                            else core.Navigate(AssetOrigin + pages[step]);
                        }
                        catch (Exception error) { Console.Error.WriteLine(error.Message); Application.Current.Shutdown(1); }
                    };
                }
                core.Navigate(Offline ? AssetOrigin + PageFile(route) : Origin + route);
            }
            catch (Exception error)
            {
                if (Smoke) { Console.Error.WriteLine(error.Message); Application.Current.Shutdown(1); return; }
                if (version == generation) Native("Desktop view unavailable", "Check that the Microsoft Edge WebView2 Runtime is installed.");
            }
        }
        AddButton(nav, "Overview", () => Native("Overview", "Desktop preview. Your existing PC Control Plane owns monitoring and automation. Embedded views are read-only."));
        AddButton(nav, "Cockpit", () => Browse("/"));
        if (!Offline)
            AddButton(nav, "Export Audit Trail", async () =>
            {
                Native("Audit Trail export", "Reading the six-day report...");
                var version = generation;
                try
                {
                    var report = await AuditExport.ReadAsync(new Uri(Origin));
                    if (generation != version) return;
                    var dialog = new Microsoft.Win32.SaveFileDialog
                    {
                        FileName = $"PC-Control-Plane-Audit-{DateTime.Now:yyyy-MM-dd}.html",
                        DefaultExt = ".html",
                        Filter = "HTML report (*.html)|*.html",
                        OverwritePrompt = true
                    };
                    if (dialog.ShowDialog(window) != true)
                    {
                        Native("Audit Trail export", "Export cancelled.");
                        return;
                    }
                    await AuditExport.SaveAsync(dialog.FileName, report);
                    if (generation == version) Native("Audit Trail export", "Report saved.");
                }
                catch
                {
                    if (generation == version)
                        Native("Audit Trail export", "The report could not be exported. Check that the local engine is running and that the destination is writable.");
                }
            });
        AddButton(nav, "Performance", () => Browse("/lab"));
        AddButton(nav, "Network", () => Native("Network", "Use the cockpit for network readings. Open Windows Network settings to manage adapters.", true));
        AddButton(nav, "Comfort", () => Browse("/comfort"));
        AddButton(nav, "Admin Toolkit", () => Native("Admin Toolkit", "These shortcuts open Windows Settings. This preview cannot change services, devices, or updates.", true));
        AddButton(nav, "Settings", () => Native("Settings", "Closing the window keeps the desktop preview in the notification area. Exit from the tray to close it."));
        AddButton(nav, "Worker status", async () =>
        {
            Native("Worker status", "Checking the local worker...");
            var version = generation;
            string status;
            try
            {
                var snapshot = await WorkerPipe.ProbeAsync();
                status = $"Preview worker connected.\nSystem uptime: {snapshot.Uptime:d\\.hh\\:mm\\:ss}\nLogical processors available to worker: {snapshot.AvailableProcessors}\nHost process private memory: {snapshot.PrivateBytes / 1048576.0:F1} MiB\nHost process CPU time: {snapshot.CpuTime.TotalSeconds:F2} seconds since launch\nWindows controls are not enabled.";
            }
            catch { status = "The preview worker is unavailable."; }
            var installed = await ReadInstalledEngineAsync();
            if (generation == version) Native("Worker status", $"{status}\n\n{installed}");
        });
        if (Smoke)
        {
            window.ShowInTaskbar = false;
            window.ShowActivated = false;
            window.Opacity = 0;
            window.Loaded += (_, _) => Browse("/");
        }
        else Native("Overview", Offline ? "Offline desktop preview. Controls cannot change Windows settings." : "Desktop preview. Your existing PC Control Plane owns monitoring and automation. Embedded views are read-only.");
        return window;
    }

    private static System.Threading.Tasks.Task<string> ReadInstalledEngineAsync() =>
        System.Threading.Tasks.Task.Run(async () =>
        {
            var registration = EngineWindowsService.ReadRegistrationStatus();
            var health = await ServiceStatusPipe.ReadAsync(ServiceStatusPipe.Name, ServiceStatusScm.RunningProcessId,
                CancellationToken.None);
            var label = health switch
            {
                ServiceStatusPipe.Health.Monitoring => "Engine responding. Monitoring is active.",
                ServiceStatusPipe.Health.ObserverStopped => "Engine responding. Monitoring is stopped.",
                _ => "Engine health not verified."
            };
            return $"Windows background service: {registration}.\n{label}";
        });

    private static bool Local(string address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var uri) && uri.Scheme == "http" &&
        uri.Host == "127.0.0.1" && uri.Port == 8792 && uri.UserInfo.Length == 0;

    private static bool Packaged(string address) =>
        Uri.TryCreate(address, UriKind.Absolute, out var uri) && uri.Scheme == "https" &&
        uri.Host == AssetHost && uri.IsDefaultPort && uri.UserInfo.Length == 0;

    private static string PageFile(string route) => route switch
    {
        "/" => "/index.html",
        "/lab" => "/lab.html",
        "/comfort" => "/comfort.html",
        _ => route
    };

    private static void AddButton(Panel panel, string text, Action action)
    {
        var button = new Button { Content = text, MinHeight = 40, Margin = new Thickness(0, 4, 0, 4) };
        button.Click += (_, _) => action();
        panel.Children.Add(button);
    }
}
