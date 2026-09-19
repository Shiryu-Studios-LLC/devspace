using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

[assembly: System.Runtime.Versioning.SupportedOSPlatform("windows")]

internal static class Program
{
    private const uint ServiceWin32OwnProcess = 0x00000010;
    private const uint ServiceStartPending = 0x00000002;
    private const uint ServiceStopPending = 0x00000003;
    private const uint ServiceRunning = 0x00000004;
    private const uint ServiceStopped = 0x00000001;
    private const uint ServiceAcceptStop = 0x00000001;
    private const uint ServiceAcceptShutdown = 0x00000004;
    private const uint ServiceControlStop = 0x00000001;
    private const uint ServiceControlShutdown = 0x00000005;
    private const uint ErrorFailedServiceControllerConnect = 1063;

    private const uint TokenAllAccess = 0x000F01FF;
    private const int SecurityImpersonation = 2;
    private const int TokenPrimary = 1;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint CreateNoWindow = 0x08000000;
    private const uint WaitTimeout = 0x00000102;

    private static readonly ManualResetEventSlim StopRequested = new(false);
    private static ServiceMainDelegate? _serviceMain;
    private static ServiceControlHandlerExDelegate? _serviceHandler;
    private static IntPtr _serviceStatusHandle;
    private static Options _options = null!;
    private static readonly object LogGate = new();

    public static int Main(string[] args)
    {
        try
        {
            _options = Options.Parse(args);
            Directory.CreateDirectory(Path.GetDirectoryName(_options.LogPath)!);

            if (_options.ConsoleMode)
                return RunConsole();

            _serviceMain = ServiceMain;
            var table = new[]
            {
                new ServiceTableEntry { ServiceName = _options.ServiceName, ServiceMain = _serviceMain },
                new ServiceTableEntry { ServiceName = null, ServiceMain = null },
            };

            if (!StartServiceCtrlDispatcher(table))
            {
                var error = Marshal.GetLastWin32Error();
                if ((uint)error == ErrorFailedServiceControllerConnect)
                {
                    Console.Error.WriteLine("This executable must be started by the Windows Service Control Manager. Use --console only for diagnostics.");
                    return error;
                }

                throw new Win32Exception(error, "StartServiceCtrlDispatcher failed.");
            }

            return 0;
        }
        catch (Exception ex)
        {
            TryLog($"fatal: {ex}");
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    private static void ServiceMain(int argc, IntPtr argv)
    {
        _serviceHandler = ServiceControlHandler;
        _serviceStatusHandle = RegisterServiceCtrlHandlerEx(_options.ServiceName, _serviceHandler, IntPtr.Zero);
        if (_serviceStatusHandle == IntPtr.Zero)
        {
            TryLog($"RegisterServiceCtrlHandlerEx failed: {Marshal.GetLastWin32Error()}");
            return;
        }

        SetServiceState(ServiceStartPending, 0, 10_000);
        TryLog($"service starting; checkout={_options.WorkingDirectory}; config={_options.ConfigDirectory}");

        var worker = new Thread(WorkerLoop)
        {
            IsBackground = true,
            Name = "DevSpace service worker",
        };
        worker.Start();

        SetServiceState(ServiceRunning, ServiceAcceptStop | ServiceAcceptShutdown, 0);
        StopRequested.Wait();

        SetServiceState(ServiceStopPending, 0, 10_000);
        worker.Join(TimeSpan.FromSeconds(10));
        SetServiceState(ServiceStopped, 0, 0);
        TryLog("service stopped");
    }

    private static uint ServiceControlHandler(uint control, uint eventType, IntPtr eventData, IntPtr context)
    {
        if (control is ServiceControlStop or ServiceControlShutdown)
            StopRequested.Set();
        return 0;
    }

    private static void WorkerLoop()
    {
        while (!StopRequested.IsSet)
        {
            try
            {
                var launched = LaunchDevSpaceAsActiveUser(out var processHandle, out var processId);
                if (!launched)
                {
                    StopRequested.Wait(TimeSpan.FromSeconds(3));
                    continue;
                }

                TryLog($"DevSpace started as active user; pid={processId}");
                try
                {
                    while (!StopRequested.IsSet)
                    {
                        var wait = WaitForSingleObject(processHandle, 1000);
                        if (wait == WaitTimeout)
                            continue;

                        if (GetExitCodeProcess(processHandle, out var exitCode))
                            TryLog($"DevSpace pid={processId} exited with code {exitCode}; retrying");
                        else
                            TryLog($"DevSpace pid={processId} exited; retrying");
                        break;
                    }

                    if (StopRequested.IsSet)
                    {
                        TerminateProcess(processHandle, 0);
                        WaitForSingleObject(processHandle, 5000);
                    }
                }
                finally
                {
                    CloseHandle(processHandle);
                }
            }
            catch (Exception ex)
            {
                TryLog($"worker error: {ex.Message}");
            }

            if (!StopRequested.IsSet)
                StopRequested.Wait(TimeSpan.FromSeconds(3));
        }
    }

    private static bool LaunchDevSpaceAsActiveUser(out IntPtr processHandle, out uint processId)
    {
        processHandle = IntPtr.Zero;
        processId = 0;

        var sessionId = WTSGetActiveConsoleSessionId();
        if (sessionId == 0xFFFFFFFF)
        {
            TryLog("no active Windows console session; waiting");
            return false;
        }

        if (!WTSQueryUserToken(sessionId, out var userToken))
        {
            var error = Marshal.GetLastWin32Error();
            TryLog($"WTSQueryUserToken(session={sessionId}) failed: {error}; waiting");
            return false;
        }

        try
        {
            using var identity = new System.Security.Principal.WindowsIdentity(userToken);
            if (_options.OwnerSid is not null && identity.User?.Value != _options.OwnerSid)
            {
                TryLog("active console user is not the configured owner; waiting");
                return false;
            }
            if (!DuplicateTokenEx(userToken, TokenAllAccess, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out var primaryToken))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateTokenEx failed.");

            try
            {
                IntPtr sourceEnvironment = IntPtr.Zero;
                IntPtr mergedEnvironment = IntPtr.Zero;
                try
                {
                    if (!CreateEnvironmentBlock(out sourceEnvironment, primaryToken, false))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateEnvironmentBlock failed.");

                    mergedEnvironment = BuildEnvironmentBlock(sourceEnvironment, new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                    {
                        ["DEVSPACE_CONFIG_DIR"] = _options.ConfigDirectory,
                        ["DEVSPACE_ADMIN_CTL"] = Path.Combine(AppContext.BaseDirectory, "devspace-adminctl.exe"),
                        ["DEVSPACE_ADMIN_TOOLS"] = "1",
                    });

                    var startup = new StartupInfo { Cb = Marshal.SizeOf<StartupInfo>() };
                    var commandLine = new StringBuilder($"\"{_options.NodePath}\" \"{_options.EntryPath}\" serve");
                    var flags = CreateUnicodeEnvironment | CreateNoWindow;

                    if (!CreateProcessAsUser(
                        primaryToken,
                        _options.NodePath,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        false,
                        flags,
                        mergedEnvironment,
                        _options.WorkingDirectory,
                        ref startup,
                        out var processInfo))
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser failed.");
                    }

                    CloseHandle(processInfo.Thread);
                    processHandle = processInfo.Process;
                    processId = processInfo.ProcessId;
                    return true;
                }
                finally
                {
                    if (mergedEnvironment != IntPtr.Zero)
                        Marshal.FreeHGlobal(mergedEnvironment);
                    if (sourceEnvironment != IntPtr.Zero)
                        DestroyEnvironmentBlock(sourceEnvironment);
                }
            }
            finally
            {
                CloseHandle(primaryToken);
            }
        }
        finally
        {
            CloseHandle(userToken);
        }
    }

    private static IntPtr BuildEnvironmentBlock(IntPtr source, IReadOnlyDictionary<string, string> overrides)
    {
        var entries = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var cursor = source;
        while (true)
        {
            var entry = Marshal.PtrToStringUni(cursor);
            if (string.IsNullOrEmpty(entry))
                break;

            var separator = entry.IndexOf('=', entry.StartsWith('=') ? 1 : 0);
            if (separator > 0)
                entries[entry[..separator]] = entry[(separator + 1)..];

            cursor = IntPtr.Add(cursor, (entry.Length + 1) * sizeof(char));
        }

        foreach (var pair in overrides)
            entries[pair.Key] = pair.Value;

        var block = string.Join('\0', entries.Select(pair => $"{pair.Key}={pair.Value}")) + "\0\0";
        return Marshal.StringToHGlobalUni(block);
    }

    private static int RunConsole()
    {
        var start = new ProcessStartInfo
        {
            FileName = _options.NodePath,
            WorkingDirectory = _options.WorkingDirectory,
            UseShellExecute = false,
        };
        start.ArgumentList.Add(_options.EntryPath);
        start.ArgumentList.Add("serve");
        start.Environment["DEVSPACE_CONFIG_DIR"] = _options.ConfigDirectory;

        using var process = Process.Start(start) ?? throw new InvalidOperationException("Unable to start DevSpace.");
        process.WaitForExit();
        return process.ExitCode;
    }

    private static void SetServiceState(uint state, uint acceptedControls, uint waitHint)
    {
        if (_serviceStatusHandle == IntPtr.Zero)
            return;

        var status = new ServiceStatus
        {
            ServiceType = ServiceWin32OwnProcess,
            CurrentState = state,
            ControlsAccepted = acceptedControls,
            Win32ExitCode = 0,
            ServiceSpecificExitCode = 0,
            CheckPoint = 0,
            WaitHint = waitHint,
        };
        SetServiceStatus(_serviceStatusHandle, ref status);
    }

    private static void TryLog(string message)
    {
        try
        {
            var logPath = _options?.LogPath ?? Path.Combine(Path.GetTempPath(), "Shiryu.DevSpace.Service.log");
            Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
            lock (LogGate)
                File.AppendAllText(logPath, $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
        }
        catch
        {
            // Service logging must never replace the primary failure.
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ServiceTableEntry
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string? ServiceName;
        public ServiceMainDelegate? ServiceMain;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatus
    {
        public uint ServiceType;
        public uint CurrentState;
        public uint ControlsAccepted;
        public uint Win32ExitCode;
        public uint ServiceSpecificExitCode;
        public uint CheckPoint;
        public uint WaitHint;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Cb;
        public string? Reserved;
        public string? Desktop;
        public string? Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public int Flags;
        public short ShowWindow;
        public short Reserved2;
        public IntPtr Reserved2Ptr;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public uint ProcessId;
        public uint ThreadId;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate void ServiceMainDelegate(int argc, IntPtr argv);

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate uint ServiceControlHandlerExDelegate(uint control, uint eventType, IntPtr eventData, IntPtr context);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool StartServiceCtrlDispatcher([In] ServiceTableEntry[] serviceTable);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr RegisterServiceCtrlHandlerEx(string serviceName, ServiceControlHandlerExDelegate callback, IntPtr context);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetServiceStatus(IntPtr serviceStatusHandle, ref ServiceStatus serviceStatus);

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(IntPtr existingToken, uint desiredAccess, IntPtr tokenAttributes, int impersonationLevel, int tokenType, out IntPtr newToken);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr environment);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(
        IntPtr token,
        string? applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private sealed record Options(
        string ServiceName,
        string NodePath,
        string EntryPath,
        string ConfigDirectory,
        string WorkingDirectory,
        string LogPath,
        string? OwnerSid,
        bool ConsoleMode)
    {
        public static Options Parse(string[] args)
        {
            static string Required(Dictionary<string, string> values, string name)
                => values.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value)
                    ? Path.GetFullPath(value)
                    : throw new ArgumentException($"Missing required option --{name}.");

            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var console = false;
            for (var i = 0; i < args.Length; i++)
            {
                if (args[i].Equals("--console", StringComparison.OrdinalIgnoreCase))
                {
                    console = true;
                    continue;
                }

                if (!args[i].StartsWith("--", StringComparison.Ordinal) || i + 1 >= args.Length)
                    throw new ArgumentException($"Invalid option: {args[i]}");
                values[args[i][2..]] = args[++i];
            }

            var serviceName = values.TryGetValue("service-name", out var configuredName) ? configuredName : "ShiryuDevSpace";
            var node = Required(values, "node");
            var entry = Required(values, "entry");
            var config = Required(values, "config");
            var workdir = Required(values, "workdir");
            var log = values.TryGetValue("log", out var configuredLog)
                ? Path.GetFullPath(configuredLog)
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Shiryu Studios", "DevSpace", "service.log");

            if (!File.Exists(node)) throw new FileNotFoundException("Node executable not found.", node);
            if (!File.Exists(entry)) throw new FileNotFoundException("DevSpace entry point not found.", entry);
            if (!Directory.Exists(config)) throw new DirectoryNotFoundException($"DevSpace config directory not found: {config}");
            if (!Directory.Exists(workdir)) throw new DirectoryNotFoundException($"DevSpace working directory not found: {workdir}");

            var ownerSid = values.TryGetValue("owner-sid", out var sid) ? sid : null;
            return new Options(serviceName, node, entry, config, workdir, log, ownerSid, console);
        }
    }
}
