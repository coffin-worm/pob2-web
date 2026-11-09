using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

namespace PoB2Web;

/// <summary>
/// PoB's calc engine, running headless beside the window.
/// </summary>
/// <remarks>
/// <para>
/// This is the same thing the dev server's Vite plugin starts, launched the
/// same way: LOVE, handed the bridge directory, with the working directory
/// set to src/ because HeadlessWrapper resolves its own dofiles against it.
/// The environment it reads is the plugin's too, so the two stay in step.
/// </para>
/// <para>
/// Two things are deliberately different. The port is ephemeral rather than
/// 49090, so two copies cannot fight over it and neither can a dev server
/// left running. And the process is put in a job object that kills it when
/// the launcher's handle closes, which is the only way on Windows to be
/// sure it cannot outlive us: the plugin's own comment admits that killing
/// the child leaves LOVE running often enough to matter, and the orphan is
/// then reused by the next start, so a change to api.lua does nothing and
/// you spend a while wondering why.
/// </para>
/// </remarks>
sealed class Engine : IDisposable
{
    readonly string _root;
    Process? _child;
    SafeJobHandle? _job;

    /// <summary>
    /// One start at a time. Several requests can find a dead engine in the
    /// same instant and they should queue behind one attempt rather than
    /// each spawning their own, which is the plugin's lesson too.
    /// </summary>
    readonly SemaphoreSlim _gate = new(1, 1);

    public int Port { get; private set; }

    /// <summary>Everything the engine said on its way up, for the failure dialog.</summary>
    readonly StringBuilder _log = new();

    public Engine(string root) => _root = root;

    public string Log
    {
        get { lock (_log) return _log.ToString(); }
    }

    /// <summary>
    /// Have an engine, starting one if there is not one already.
    /// </summary>
    /// <remarks>
    /// Cheap to call and safe to call from anywhere, which is what lets the
    /// proxy call it before every request: an engine that crashed at some
    /// point in the afternoon then costs one slow request rather than an
    /// application that is dead until it is restarted.
    /// </remarks>
    public async Task EnsureAsync(CancellationToken token)
    {
        if (_child is { HasExited: false }) return;

        await _gate.WaitAsync(token);
        try
        {
            if (_child is { HasExited: false }) return;
            await StartAsync(token);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Start it, and come back when it is answering.
    /// </summary>
    async Task StartAsync(CancellationToken token)
    {
        // Whatever is left of the last one, including its job: a second job
        // handle held open would keep a dead process's slot forever.
        Stop();

        var love = Paths.FindLove(_root);
        Port = FreePort();

        var src = Path.Combine(_root, "src");
        var bridge = Path.Combine(_root, "bridge");

        var info = new ProcessStartInfo(love)
        {
            WorkingDirectory = src,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.ArgumentList.Add(bridge);
        info.Environment["POB_SRC"] = src;
        info.Environment["POB_RUNTIME"] = Path.Combine(_root, "runtime");
        info.Environment["POB_BRIDGE_DIR"] = bridge;
        info.Environment["POB_BRIDGE_PORT"] = Port.ToString();

        // The job comes first. A crash between spawning and assigning would
        // leave exactly the orphan this exists to prevent.
        _job = CreateKillOnCloseJob();

        _child = new Process { StartInfo = info, EnableRaisingEvents = true };
        _child.OutputDataReceived += (_, e) => Note(e.Data);
        _child.ErrorDataReceived += (_, e) => Note(e.Data);

        if (!_child.Start())
        {
            throw new LaunchFailure($"{love} would not start.");
        }

        AssignToJob(_job, _child);
        _child.BeginOutputReadLine();
        _child.BeginErrorReadLine();

        await WaitUntilAnswering(token);
    }

    void Note(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        lock (_log)
        {
            // PoB is chatty on boot, and a failure dialog holding every line
            // of it helps nobody. The tail is where the reason will be.
            if (_log.Length > 8000) _log.Remove(0, _log.Length - 6000);
            _log.AppendLine(line);
        }
    }

    /// <summary>
    /// Poll /health rather than watch for a line on stdout.
    /// </summary>
    /// <remarks>
    /// The plugin settles on the engine's own "listening on" line, which is
    /// fine when you own the terminal it goes to. Here the only thing that
    /// matters is whether the socket answers, and asking it directly also
    /// covers the case where the engine is up but the line was missed.
    /// </remarks>
    async Task WaitUntilAnswering(CancellationToken token)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(700) };
        var deadline = DateTime.UtcNow.AddSeconds(60);

        while (DateTime.UtcNow < deadline)
        {
            token.ThrowIfCancellationRequested();

            if (_child is { HasExited: true })
            {
                throw new LaunchFailure(
                    $"The engine exited with code {_child.ExitCode} before it was ready." +
                    (Log.Length > 0 ? "\r\n\r\n" + Log : ""));
            }

            try
            {
                var response = await client.GetAsync($"http://127.0.0.1:{Port}/health", token);
                if (response.IsSuccessStatusCode) return;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                // Not up yet, which is the normal answer for the first
                // several seconds: PoB parses its whole data set on boot.
            }

            await Task.Delay(200, token);
        }

        throw new LaunchFailure(
            "The engine did not answer within 60 seconds." +
            (Log.Length > 0 ? "\r\n\r\n" + Log : ""));
    }

    /// <summary>
    /// A port nobody is on, by asking the OS for one and letting it go.
    /// </summary>
    /// <remarks>
    /// There is a race here in principle, between the listener closing and
    /// the engine binding. In practice the window is microseconds and the
    /// alternative is a fixed port, whose failure mode is not a race but a
    /// certainty whenever a dev server is already running.
    /// </remarks>
    static int FreePort()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return port;
    }

    public void Dispose()
    {
        Stop();
        _gate.Dispose();
    }

    void Stop()
    {
        // Closing the job handle is what kills the engine, and it works even
        // if this process is killed rather than closed. The polite request
        // first, so a clean exit stays clean.
        try
        {
            if (_child is { HasExited: false }) _child.Kill(entireProcessTree: true);
        }
        catch
        {
            // Already gone, or gone between the test and the kill.
        }

        _child?.Dispose();
        _child = null;
        _job?.Dispose();
        _job = null;
    }

    // ---------------------------------------------------------------- job

    const int JobObjectExtendedLimitInformation = 9;
    const uint JobObjectLimitKillOnJobClose = 0x2000;

    static SafeJobHandle CreateKillOnCloseJob()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job.IsInvalid)
        {
            throw new LaunchFailure(
                "Windows would not create a job object for the engine: " +
                new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message);
        }

        var limits = new JobObjectExtendedLimitInformationStruct();
        limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;

        var size = Marshal.SizeOf(limits);
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size))
            {
                throw new LaunchFailure(
                    "Windows would not set the engine's job limits: " +
                    new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }

        return job;
    }

    static void AssignToJob(SafeJobHandle job, Process child)
    {
        if (!AssignProcessToJobObject(job, child.Handle))
        {
            throw new LaunchFailure(
                "Windows would not put the engine in its job object: " +
                new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message);
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeJobHandle CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool SetInformationJobObject(
        SafeJobHandle job, int infoClass, IntPtr info, uint infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool AssignProcessToJobObject(SafeJobHandle job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobObjectExtendedLimitInformationStruct
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}

sealed class SafeJobHandle() : Microsoft.Win32.SafeHandles.SafeHandleZeroOrMinusOneIsInvalid(true)
{
    protected override bool ReleaseHandle() => CloseHandle(handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CloseHandle(IntPtr handle);
}
