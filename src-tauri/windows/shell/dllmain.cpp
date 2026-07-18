#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <string>
#include <vector>
#include <new>

#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")

// Root submenu "Zinnia"
// {B7E2A91C-6D4F-4A3E-9C1B-8F0E2D3A4B5C}
static const CLSID CLSID_ZinniaRoot = {
    0xb7e2a91c, 0x6d4f, 0x4a3e, {0x9c, 0x1b, 0x8f, 0x0e, 0x2d, 0x3a, 0x4b, 0x5c}};
// Top-level "Extract with Zinnia" on archives
// {B7E2A91C-6D4F-4A3E-9C1B-8F0E2D3A4B5D}
static const CLSID CLSID_ZinniaExtractTop = {
    0xb7e2a91c, 0x6d4f, 0x4a3e, {0x9c, 0x1b, 0x8f, 0x0e, 0x2d, 0x3a, 0x4b, 0x5d}};

enum class CommandKind { Root, Extract, Compress, ExtractTop };

static LONG g_moduleRefs = 0;
static HINSTANCE g_hInst = nullptr;

static void AddRefModule() { InterlockedIncrement(&g_moduleRefs); }
static void ReleaseModule() { InterlockedDecrement(&g_moduleRefs); }

static bool LooksLikeArchive(const std::wstring& path) {
  static const wchar_t* kExts[] = {L".7z",  L".zip", L".tar", L".gz",
                                   L".tgz", L".bz2", L".tbz2", L".xz",
                                   L".txz"};
  const wchar_t* ext = PathFindExtensionW(path.c_str());
  if (!ext || !*ext) return false;
  for (const wchar_t* candidate : kExts) {
    if (_wcsicmp(ext, candidate) == 0) return true;
  }
  // .tar.gz / .tar.xz style
  std::wstring lower = path;
  for (auto& ch : lower) ch = static_cast<wchar_t>(towlower(ch));
  auto ends_with = [](const std::wstring& value, const wchar_t* suffix) {
    const size_t n = wcslen(suffix);
    return value.size() >= n &&
           _wcsicmp(value.c_str() + (value.size() - n), suffix) == 0;
  };
  return ends_with(lower, L".tar.gz") || ends_with(lower, L".tar.xz") ||
         ends_with(lower, L".tar.bz2");
}

static HRESULT GetSelectedPaths(IShellItemArray* items,
                                std::vector<std::wstring>* out) {
  if (!items || !out) return E_INVALIDARG;
  out->clear();
  DWORD count = 0;
  HRESULT hr = items->GetCount(&count);
  if (FAILED(hr)) return hr;
  for (DWORD i = 0; i < count; ++i) {
    IShellItem* item = nullptr;
    hr = items->GetItemAt(i, &item);
    if (FAILED(hr) || !item) continue;
    PWSTR path = nullptr;
    hr = item->GetDisplayName(SIGDN_FILESYSPATH, &path);
    if (SUCCEEDED(hr) && path) {
      out->emplace_back(path);
      CoTaskMemFree(path);
    }
    item->Release();
  }
  return out->empty() ? E_FAIL : S_OK;
}

// DLL is usually next to zinnia.exe ($INSTDIR). If mapped under resources\,
// fall back to the parent directory.
static std::wstring GetZinniaExePath() {
  wchar_t moduleDir[MAX_PATH] = {};
  GetModuleFileNameW(g_hInst, moduleDir, MAX_PATH);
  PathRemoveFileSpecW(moduleDir);

  wchar_t candidate[MAX_PATH] = {};
  PathCombineW(candidate, moduleDir, L"zinnia.exe");
  if (PathFileExistsW(candidate)) return candidate;

  wchar_t parentDir[MAX_PATH] = {};
  lstrcpynW(parentDir, moduleDir, MAX_PATH);
  if (PathRemoveFileSpecW(parentDir)) {
    PathCombineW(candidate, parentDir, L"zinnia.exe");
    if (PathFileExistsW(candidate)) return candidate;
  }

  // Last resort: return same-dir path for error reporting.
  PathCombineW(candidate, moduleDir, L"zinnia.exe");
  return candidate;
}

static HRESULT LaunchZinnia(const wchar_t* flag,
                            const std::vector<std::wstring>& paths) {
  if (paths.empty()) return E_FAIL;
  std::wstring exe = GetZinniaExePath();
  if (!PathFileExistsW(exe.c_str())) return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);

  std::wstring params = flag;
  for (const auto& path : paths) {
    params += L" \"";
    for (wchar_t ch : path) {
      if (ch == L'"') params += L'\\';
      params += ch;
    }
    // Trailing backslash before " would escape the quote for CommandLineToArgvW.
    if (!path.empty() && path.back() == L'\\') {
      params += L'\\';
    }
    params += L'"';
  }

  SHELLEXECUTEINFOW sei = {};
  sei.cbSize = sizeof(sei);
  sei.fMask = SEE_MASK_NOCLOSEPROCESS;
  sei.lpVerb = L"open";
  sei.lpFile = exe.c_str();
  sei.lpParameters = params.c_str();
  sei.nShow = SW_SHOWNORMAL;
  if (!ShellExecuteExW(&sei)) {
    return HRESULT_FROM_WIN32(GetLastError());
  }
  if (sei.hProcess) CloseHandle(sei.hProcess);
  return S_OK;
}

class ExplorerCommand : public IExplorerCommand {
 public:
  ExplorerCommand(CommandKind kind) : kind_(kind) { AddRefModule(); }
  ~ExplorerCommand() { ReleaseModule(); }

  // IUnknown
  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (riid == IID_IUnknown || riid == IID_IExplorerCommand) {
      *ppv = static_cast<IExplorerCommand*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override {
    return InterlockedIncrement(&refs_);
  }
  IFACEMETHODIMP_(ULONG) Release() override {
    ULONG c = InterlockedDecrement(&refs_);
    if (c == 0) delete this;
    return c;
  }

  IFACEMETHODIMP GetTitle(IShellItemArray*, LPWSTR* name) override {
    const wchar_t* title = L"Zinnia";
    switch (kind_) {
      case CommandKind::Extract:
      case CommandKind::ExtractTop:
        title = L"Extract with Zinnia";
        break;
      case CommandKind::Compress:
        title = L"Compress with Zinnia";
        break;
      case CommandKind::Root:
      default:
        title = L"Zinnia";
        break;
    }
    return SHStrDupW(title, name);
  }

  IFACEMETHODIMP GetIcon(IShellItemArray*, LPWSTR* icon) override {
    std::wstring exe = GetZinniaExePath();
    return SHStrDupW(exe.c_str(), icon);
  }

  IFACEMETHODIMP GetToolTip(IShellItemArray*, LPWSTR* tip) override {
    *tip = nullptr;
    return E_NOTIMPL;
  }

  IFACEMETHODIMP GetCanonicalName(GUID* guid) override {
    switch (kind_) {
      case CommandKind::Root:
        *guid = CLSID_ZinniaRoot;
        break;
      case CommandKind::ExtractTop:
        *guid = CLSID_ZinniaExtractTop;
        break;
      case CommandKind::Extract:
        *guid = CLSID_ZinniaExtractTop;  // stable-ish id for child
        break;
      case CommandKind::Compress: {
        static const GUID kCompress = {
            0xb7e2a91c,
            0x6d4f,
            0x4a3e,
            {0x9c, 0x1b, 0x8f, 0x0e, 0x2d, 0x3a, 0x4b, 0x5e}};
        *guid = kCompress;
        break;
      }
    }
    return S_OK;
  }

  IFACEMETHODIMP GetState(IShellItemArray* selection, BOOL, EXPCMDSTATE* state) override {
    *state = ECS_ENABLED;
    if (kind_ == CommandKind::Extract || kind_ == CommandKind::ExtractTop) {
      std::vector<std::wstring> paths;
      if (FAILED(GetSelectedPaths(selection, &paths))) {
        *state = ECS_DISABLED;
        return S_OK;
      }
      bool anyArchive = false;
      for (const auto& p : paths) {
        if (LooksLikeArchive(p)) {
          anyArchive = true;
          break;
        }
      }
      if (!anyArchive) *state = ECS_DISABLED;
    }
    return S_OK;
  }

  IFACEMETHODIMP Invoke(IShellItemArray* selection, IBindCtx*) override {
    std::vector<std::wstring> paths;
    HRESULT hr = GetSelectedPaths(selection, &paths);
    if (FAILED(hr)) return hr;
    switch (kind_) {
      case CommandKind::Extract:
      case CommandKind::ExtractTop:
        return LaunchZinnia(L"--extract", paths);
      case CommandKind::Compress:
        return LaunchZinnia(L"--compress", paths);
      case CommandKind::Root:
      default:
        return S_OK;
    }
  }

  IFACEMETHODIMP GetFlags(EXPCMDFLAGS* flags) override {
    *flags = (kind_ == CommandKind::Root) ? ECF_HASSUBCOMMANDS : ECF_DEFAULT;
    return S_OK;
  }

  IFACEMETHODIMP EnumSubCommands(IEnumExplorerCommand** enumCommands) override;

 private:
  LONG refs_ = 1;
  CommandKind kind_;
};

class EnumCommands : public IEnumExplorerCommand {
 public:
  EnumCommands() {
    AddRefModule();
    commands_.push_back(new ExplorerCommand(CommandKind::Extract));
    commands_.push_back(new ExplorerCommand(CommandKind::Compress));
  }
  ~EnumCommands() {
    for (auto* c : commands_) c->Release();
    ReleaseModule();
  }

  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (riid == IID_IUnknown || riid == IID_IEnumExplorerCommand) {
      *ppv = static_cast<IEnumExplorerCommand*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override {
    return InterlockedIncrement(&refs_);
  }
  IFACEMETHODIMP_(ULONG) Release() override {
    ULONG c = InterlockedDecrement(&refs_);
    if (c == 0) delete this;
    return c;
  }

  IFACEMETHODIMP Next(ULONG celt, IExplorerCommand** rgelt, ULONG* fetched) override {
    ULONG got = 0;
    while (got < celt && index_ < commands_.size()) {
      rgelt[got] = commands_[index_++];
      rgelt[got]->AddRef();
      ++got;
    }
    if (fetched) *fetched = got;
    return got == celt ? S_OK : S_FALSE;
  }
  IFACEMETHODIMP Skip(ULONG celt) override {
    index_ = (std::min)(index_ + celt, commands_.size());
    return S_OK;
  }
  IFACEMETHODIMP Reset() override {
    index_ = 0;
    return S_OK;
  }
  IFACEMETHODIMP Clone(IEnumExplorerCommand** ppenum) override {
    *ppenum = nullptr;
    return E_NOTIMPL;
  }

 private:
  LONG refs_ = 1;
  size_t index_ = 0;
  std::vector<ExplorerCommand*> commands_;
};

IFACEMETHODIMP ExplorerCommand::EnumSubCommands(
    IEnumExplorerCommand** enumCommands) {
  if (kind_ != CommandKind::Root) return E_NOTIMPL;
  *enumCommands = new (std::nothrow) EnumCommands();
  return *enumCommands ? S_OK : E_OUTOFMEMORY;
}

class ClassFactory : public IClassFactory {
 public:
  ClassFactory(CommandKind kind) : kind_(kind) { AddRefModule(); }
  ~ClassFactory() { ReleaseModule(); }

  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (riid == IID_IUnknown || riid == IID_IClassFactory) {
      *ppv = static_cast<IClassFactory*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }
  IFACEMETHODIMP_(ULONG) AddRef() override {
    return InterlockedIncrement(&refs_);
  }
  IFACEMETHODIMP_(ULONG) Release() override {
    ULONG c = InterlockedDecrement(&refs_);
    if (c == 0) delete this;
    return c;
  }
  IFACEMETHODIMP CreateInstance(IUnknown* outer, REFIID riid,
                                void** ppv) override {
    if (outer) return CLASS_E_NOAGGREGATION;
    ExplorerCommand* cmd = new (std::nothrow) ExplorerCommand(kind_);
    if (!cmd) return E_OUTOFMEMORY;
    HRESULT hr = cmd->QueryInterface(riid, ppv);
    cmd->Release();
    return hr;
  }
  IFACEMETHODIMP LockServer(BOOL lock) override {
    if (lock) AddRefModule();
    else ReleaseModule();
    return S_OK;
  }

 private:
  LONG refs_ = 1;
  CommandKind kind_;
};

BOOL APIENTRY DllMain(HINSTANCE hModule, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_hInst = hModule;
    DisableThreadLibraryCalls(hModule);
  }
  return TRUE;
}

STDAPI DllCanUnloadNow() {
  return g_moduleRefs == 0 ? S_OK : S_FALSE;
}

STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv) {
  CommandKind kind;
  if (IsEqualCLSID(rclsid, CLSID_ZinniaRoot)) {
    kind = CommandKind::Root;
  } else if (IsEqualCLSID(rclsid, CLSID_ZinniaExtractTop)) {
    kind = CommandKind::ExtractTop;
  } else {
    return CLASS_E_CLASSNOTAVAILABLE;
  }
  ClassFactory* factory = new (std::nothrow) ClassFactory(kind);
  if (!factory) return E_OUTOFMEMORY;
  HRESULT hr = factory->QueryInterface(riid, ppv);
  factory->Release();
  return hr;
}
