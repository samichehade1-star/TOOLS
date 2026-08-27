using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Fiddler;

// ═══════════════════════════════════════════════════════════════════
//  DIDDLER ENGINE — headless capture/send helper spawned by the
//  Electron UI. Talks to its parent over stdio using newline-delimited
//  JSON (see PROTOCOL.md alongside main.js for the message shapes).
//
//  This is the exact FiddlerCore capture/send logic from the original
//  Diddler WinForms app — only the UI was stripped out. Behavior is
//  intentionally unchanged; the only edits are (1) exposing the target
//  paths as public consts so Program can route commands, and (2) reusing
//  one static HttpClient instead of allocating a new HttpClientHandler
//  per send.
// ═══════════════════════════════════════════════════════════════════

static class Program
{
    static CaptureEngine? _engine;

    static async Task Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        _engine = new CaptureEngine();

        _engine.LogMessage      += (m, l) => Emit(new { type = "log", level = l.ToString().ToLowerInvariant(), message = m });
        _engine.OnAddCapture    += _      => Emit(new { type = "captured", kind = "add" });
        _engine.OnRemoveCapture += _      => Emit(new { type = "captured", kind = "remove" });

        Emit(new { type = "status", state = "starting" });
        bool ok = _engine.Start();
        Emit(ok
            ? new { type = "status", state = "ready", message = (string?)null }
            : new { type = "status", state = "error", message = (string?)"Failed to start capture proxy" });

        string? line;
        while ((line = await Console.In.ReadLineAsync()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try { await HandleCommand(line); }
            catch (Exception ex) { Emit(new { type = "log", level = "err", message = $"Command error: {ex.Message}" }); }
        }

        _engine.Stop();
    }

    static async Task HandleCommand(string line)
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        var cmd = root.GetProperty("cmd").GetString();

        if (cmd == "send")
        {
            var kind = root.GetProperty("kind").GetString() ?? "";
            var playerId = root.GetProperty("playerId").GetString() ?? "";
            bool isAdd = kind == "add";

            var cap = isAdd ? _engine!.AddCapture : _engine!.RemoveCapture;
            if (cap == null)
            {
                Emit(new { type = "result", kind, ok = false, status = "No token captured yet — trigger a friend request in-game first" });
                return;
            }

            var path = isAdd ? CaptureEngine.PATH_ADD : CaptureEngine.PATH_REMOVE;
            var (ok, status) = await _engine!.SendRequest(cap, path, playerId);
            Emit(new { type = "result", kind, ok, status });
        }
        else if (cmd == "shutdown")
        {
            _engine!.Stop();
            Environment.Exit(0);
        }
    }

    static readonly object _writeLock = new();
    static void Emit(object payload)
    {
        var json = JsonSerializer.Serialize(payload);
        lock (_writeLock)
        {
            Console.WriteLine(json);
            Console.Out.Flush();
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
//  DATA
// ═══════════════════════════════════════════════════════════════════
record CapturedRequest
{
    public Dictionary<string, string> Headers { get; init; } = new();
    public JsonElement BodyJson  { get; init; }
    public string      Host      { get; init; } = "";
    public string      Path      { get; init; } = "";
}
enum LogLevel { Info, Ok, Err, Discovery }

// ═══════════════════════════════════════════════════════════════════
//  FIDDLERCORE ENGINE
//  Uses FiddlerCore NuGet — same engine as Fiddler itself.
//  No system proxy conflicts, no keep-alive issues, no interference.
// ═══════════════════════════════════════════════════════════════════
class CaptureEngine
{
    const string TARGET_HOST = "grdk.live.bhvrdbd.com";
    public const string PATH_ADD    = "/api/v1/players/friends/add";
    public const string PATH_REMOVE = "/api/v1/players/friends/remove";
    const int    PROXY_PORT  = 8877;

    public CapturedRequest? AddCapture    { get; private set; }
    public CapturedRequest? RemoveCapture { get; private set; }

    public event Action<string, LogLevel>? LogMessage;
    public event Action<CapturedRequest>?  OnAddCapture;
    public event Action<CapturedRequest>?  OnRemoveCapture;
    public event Action<string, string>?   OnUrlDiscovered;

    readonly HashSet<string> _seenPaths = new();

    static readonly HttpClient _http = new(new HttpClientHandler
    {
        ServerCertificateCustomValidationCallback = (_, _, _, _) => true
    })
    { Timeout = TimeSpan.FromSeconds(15) };

    public bool Start()
    {
        try
        {
            // Hook session events before starting
            FiddlerApplication.BeforeRequest        += OnBeforeRequest;
            FiddlerApplication.BeforeResponse       += OnBeforeResponse;
            FiddlerApplication.AfterSessionComplete += OnSessionComplete;

            // Install root cert if needed (same as Fiddler's "Trust Root Cert")
            if (!CertMaker.rootCertExists())
                CertMaker.createRootCert();
            if (!CertMaker.rootCertIsTrusted())
                CertMaker.trustRootCert();

            // Startup flags: act as system proxy + decrypt HTTPS
            var flags = FiddlerCoreStartupFlags.RegisterAsSystemProxy
                      | FiddlerCoreStartupFlags.DecryptSSL;

            FiddlerApplication.Startup(PROXY_PORT, flags);
            Log($"FiddlerCore proxy started on port {PROXY_PORT}", LogLevel.Ok);
            return true;
        }
        catch (Exception ex)
        {
            var inner = ex.InnerException;
            var detail = inner != null ? $"{ex.Message} -> {inner.Message}" : ex.Message;
            Log($"FiddlerCore start failed: {detail}", LogLevel.Err);
            return false;
        }
    }

    public void Stop()
    {
        try
        {
            FiddlerApplication.BeforeRequest  -= OnBeforeRequest;
            FiddlerApplication.BeforeResponse -= OnBeforeResponse;
            FiddlerApplication.AfterSessionComplete -= OnSessionComplete;
            FiddlerApplication.Shutdown();
            Log("FiddlerCore stopped.", LogLevel.Info);
        }
        catch { }
    }

    void OnBeforeRequest(Session s)
    {
        // Only care about our target host
        if (!s.hostname.Equals(TARGET_HOST, StringComparison.OrdinalIgnoreCase)) return;

        var path = s.PathAndQuery;

        // Log every new URL we see from this host
        var key = $"{s.RequestMethod} {path}";
        lock (_seenPaths)
        {
            if (_seenPaths.Add(key))
            {
                Log($"[URL]  {s.RequestMethod}  {path}", LogLevel.Discovery);
                OnUrlDiscovered?.Invoke(s.RequestMethod, path);
            }
        }
    }

    void OnBeforeResponse(Session s)
    {
        if (!s.hostname.Equals(TARGET_HOST, StringComparison.OrdinalIgnoreCase)) return;

        var path = s.PathAndQuery;

        // Capture friend-add
        if (path.StartsWith(PATH_ADD, StringComparison.OrdinalIgnoreCase))
            TryCapture(s, isAdd: true);
        // Capture friend-remove
        else if (path.StartsWith(PATH_REMOVE, StringComparison.OrdinalIgnoreCase))
            TryCapture(s, isAdd: false);
    }

    void OnSessionComplete(Session s) { /* no-op — here for future use */ }

    void TryCapture(Session s, bool isAdd)
    {
        try
        {
            var body = s.GetRequestBodyAsString();
            var json = JsonDocument.Parse(body);

            // Build headers dict from FiddlerCore headers
            var hdrs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (HTTPHeaderItem h in s.oRequest.headers)
                hdrs[h.Name] = h.Value;

            var cap = new CapturedRequest
            {
                Headers  = hdrs,
                BodyJson = json.RootElement.Clone(),
                Host     = s.hostname,
                Path     = s.PathAndQuery,
            };

            string fid = "";
            try { fid = cap.BodyJson.GetProperty("ids")[0].GetString() ?? ""; } catch { }

            if (isAdd)
            {
                AddCapture = cap;
                Log($"ADD token captured  [{fid[..Math.Min(8, fid.Length)]}...]", LogLevel.Ok);
                OnAddCapture?.Invoke(cap);
            }
            else
            {
                RemoveCapture = cap;
                Log($"REMOVE token captured  [{fid[..Math.Min(8, fid.Length)]}...]", LogLevel.Ok);
                OnRemoveCapture?.Invoke(cap);
            }
        }
        catch (Exception ex) { Log($"Capture parse error: {ex.Message}", LogLevel.Err); }
    }

    // ── send custom request using captured token ───────────────────
    public async Task<(bool ok, string status)> SendRequest(
        CapturedRequest cap, string path, string playerId)
    {
        try
        {
            var payload = JsonSerializer.SerializeToUtf8Bytes(
                new { ids = new[] { playerId }, platform = "kraken" });

            var skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "content-length", "transfer-encoding", "connection",
                "host", "content-type", "proxy-connection"
            };

            var req = new HttpRequestMessage(HttpMethod.Post,
                $"https://{TARGET_HOST}{path}");
            req.Content = new ByteArrayContent(payload);
            req.Content.Headers.ContentType =
                new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");

            foreach (var kv in cap.Headers)
                if (!skip.Contains(kv.Key))
                    req.Headers.TryAddWithoutValidation(kv.Key, kv.Value);

            var resp  = await _http.SendAsync(req);
            var rb    = await resp.Content.ReadAsStringAsync();
            return ((int)resp.StatusCode < 400,
                    $"{(int)resp.StatusCode} {resp.ReasonPhrase}  {rb[..Math.Min(300, rb.Length)]}");
        }
        catch (Exception ex) { return (false, ex.Message); }
    }

    void Log(string msg, LogLevel lvl) => LogMessage?.Invoke(msg, lvl);
}
