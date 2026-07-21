#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <string>
#include <vector>
#include <new>
#include <algorithm>
#include <filesystem>

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

static bool AllPathsAreArchives(const std::vector<std::wstring>& paths) {
  return !paths.empty() &&
         std::all_of(paths.begin(), paths.end(), LooksLikeArchive);
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

// Directory\Background often has a null/empty selection; resolve the open folder
// via the Explorer site (IFolderView).
static HRESULT GetFolderPathFromSite(IUnknown* site, std::wstring* out) {
  if (!site || !out) return E_INVALIDARG;
  out->clear();

  IServiceProvider* sp = nullptr;
  HRESULT hr = site->QueryInterface(IID_PPV_ARGS(&sp));
  if (FAILED(hr) || !sp) return FAILED(hr) ? hr : E_FAIL;

  IFolderView* folderView = nullptr;
  hr = sp->QueryService(SID_SFolderView, IID_PPV_ARGS(&folderView));
  sp->Release();
  if (FAILED(hr) || !folderView) return FAILED(hr) ? hr : E_FAIL;

  IShellItem* folder = nullptr;
  hr = folderView->GetFolder(IID_PPV_ARGS(&folder));
  folderView->Release();
  if (FAILED(hr) || !folder) return FAILED(hr) ? hr : E_FAIL;

  PWSTR path = nullptr;
  hr = folder->GetDisplayName(SIGDN_FILESYSPATH, &path);
  folder->Release();
  if (FAILED(hr) || !path) return FAILED(hr) ? hr : E_FAIL;
  *out = path;
  CoTaskMemFree(path);
  return S_OK;
}

// DLL is usually next to zinnia.exe ($INSTDIR). If mapped under resources\,
// fall back to the parent directory.
static std::wstring GetZinniaExePath() {
  std::vector<wchar_t> buffer(512);
  DWORD length = 0;
  for (;;) {
    SetLastError(ERROR_SUCCESS);
    length = GetModuleFileNameW(g_hInst, buffer.data(),
                                static_cast<DWORD>(buffer.size()));
    if (length == 0) return L"zinnia.exe";
    if (length < buffer.size()) break;
    buffer.resize(buffer.size() * 2);
  }

  const std::filesystem::path modulePath(
      std::wstring(buffer.data(), static_cast<size_t>(length)));
  const auto moduleDir = modulePath.parent_path();
  auto candidate = moduleDir / L"zinnia.exe";
  if (GetFileAttributesW(candidate.c_str()) != INVALID_FILE_ATTRIBUTES) {
    return candidate.wstring();
  }

  candidate = moduleDir.parent_path() / L"zinnia.exe";
  if (GetFileAttributesW(candidate.c_str()) != INVALID_FILE_ATTRIBUTES) {
    return candidate.wstring();
  }

  // Last resort: return same-dir path for error reporting.
  return (moduleDir / L"zinnia.exe").wstring();
}

static HRESULT LaunchZinnia(const wchar_t* flag,
                            const std::vector<std::wstring>& paths) {
  if (paths.empty()) return E_FAIL;
  std::wstring exe = GetZinniaExePath();
  if (GetFileAttributesW(exe.c_str()) == INVALID_FILE_ATTRIBUTES) {
    return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
  }

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

class ExplorerCommand : public IExplorerCommand, public IObjectWithSite {
 public:
  ExplorerCommand(CommandKind kind) : kind_(kind) { AddRefModule(); }
  ~ExplorerCommand() {
    if (site_) site_->Release();
    ReleaseModule();
  }

  void SetSiteFromParent(IUnknown* site) {
    if (site_) {
      site_->Release();
      site_ = nullptr;
    }
    site_ = site;
    if (site_) site_->AddRef();
  }

  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    if (riid == IID_IUnknown || riid == IID_IExplorerCommand) {
      *ppv = static_cast<IExplorerCommand*>(this);
      AddRef();
      return S_OK;
    }
    if (riid == IID_IObjectWithSite) {
      *ppv = static_cast<IObjectWithSite*>(this);
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

  IFACEMETHODIMP SetSite(IUnknown* punkSite) override {
    SetSiteFromParent(punkSite);
    return S_OK;
  }
  IFACEMETHODIMP GetSite(REFIID riid, void** ppvSite) override {
    if (!ppvSite) return E_POINTER;
    *ppvSite = nullptr;
    if (!site_) return E_FAIL;
    return site_->QueryInterface(riid, ppvSite);
  }

  IFACEMETHODIMP GetTitle(IShellItemArray*, LPWSTR* name) override {
    if (!name) return E_POINTER;
    const wchar_t* title = L"Zinnia";
    switch (kind_) {
      case CommandKind::ExtractTop:
        title = L"Extract with Zinnia";
        break;
      case CommandKind::Extract:
        title = L"Extract";
        break;
      case CommandKind::Compress:
        title = L"Compress";
        break;
      case CommandKind::Root:
      default:
        title = L"Zinnia";
        break;
    }
    return SHStrDupW(title, name);
  }

  IFACEMETHODIMP GetIcon(IShellItemArray*, LPWSTR* icon) override {
    if (!icon) return E_POINTER;
    std::wstring exe = GetZinniaExePath();
    return SHStrDupW(exe.c_str(), icon);
  }

  IFACEMETHODIMP GetToolTip(IShellItemArray*, LPWSTR* tip) override {
    if (!tip) return E_POINTER;
    *tip = nullptr;
    return E_NOTIMPL;
  }

  IFACEMETHODIMP GetCanonicalName(GUID* guid) override {
    if (!guid) return E_POINTER;
    switch (kind_) {
      case CommandKind::Root:
        *guid = CLSID_ZinniaRoot;
        break;
      case CommandKind::ExtractTop:
        *guid = CLSID_ZinniaExtractTop;
        break;
      case CommandKind::Extract: {
        // Distinct from ExtractTop so Explorer does not merge the two commands.
        static const GUID kExtractSub = {
            0xb7e2a91c,
            0x6d4f,
            0x4a3e,
            {0x9c, 0x1b, 0x8f, 0x0e, 0x2d, 0x3a, 0x4b, 0x5f}};
        *guid = kExtractSub;
        break;
      }
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

  HRESULT ResolvePaths(IShellItemArray* selection,
                       std::vector<std::wstring>* paths) {
    if (!paths) return E_INVALIDARG;
    if (SUCCEEDED(GetSelectedPaths(selection, paths))) return S_OK;
    std::wstring folder;
    if (site_ && SUCCEEDED(GetFolderPathFromSite(site_, &folder)) &&
        !folder.empty()) {
      paths->clear();
      paths->push_back(folder);
      return S_OK;
    }
    return E_FAIL;
  }

  IFACEMETHODIMP GetState(IShellItemArray* selection, BOOL, EXPCMDSTATE* state) override {
    if (!state) return E_POINTER;
    *state = ECS_ENABLED;
    if (kind_ == CommandKind::Extract || kind_ == CommandKind::ExtractTop) {
      std::vector<std::wstring> paths;
      if (FAILED(ResolvePaths(selection, &paths))) {
        *state = ECS_DISABLED;
        return S_OK;
      }
      if (!AllPathsAreArchives(paths)) *state = ECS_DISABLED;
    }
    return S_OK;
  }

  IFACEMETHODIMP Invoke(IShellItemArray* selection, IBindCtx*) override {
    std::vector<std::wstring> paths;
    HRESULT hr = ResolvePaths(selection, &paths);
    if (FAILED(hr)) return hr;
    switch (kind_) {
      case CommandKind::Extract:
      case CommandKind::ExtractTop:
        if (!AllPathsAreArchives(paths)) return E_INVALIDARG;
        return LaunchZinnia(L"--extract", paths);
      case CommandKind::Compress:
        return LaunchZinnia(L"--compress", paths);
      case CommandKind::Root:
      default:
        return S_OK;
    }
  }

  IFACEMETHODIMP GetFlags(EXPCMDFLAGS* flags) override {
    if (!flags) return E_POINTER;
    *flags = (kind_ == CommandKind::Root) ? ECF_HASSUBCOMMANDS : ECF_DEFAULT;
    return S_OK;
  }

  IFACEMETHODIMP EnumSubCommands(IEnumExplorerCommand** enumCommands) override;

 private:
  LONG refs_ = 1;
  CommandKind kind_;
  IUnknown* site_ = nullptr;
};

class EnumCommands : public IEnumExplorerCommand {
 public:
  EnumCommands() { AddRefModule(); }

  HRESULT Initialize(IUnknown* site) {
    auto* extract = new (std::nothrow) ExplorerCommand(CommandKind::Extract);
    if (!extract) return E_OUTOFMEMORY;
    auto* compress = new (std::nothrow) ExplorerCommand(CommandKind::Compress);
    if (!compress) {
      extract->Release();
      return E_OUTOFMEMORY;
    }
    extract->SetSiteFromParent(site);
    compress->SetSiteFromParent(site);
    try {
      commands_.reserve(2);
      commands_.push_back(extract);
      commands_.push_back(compress);
    } catch (const std::bad_alloc&) {
      extract->Release();
      compress->Release();
      return E_OUTOFMEMORY;
    }
    return S_OK;
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
    if (!rgelt || (celt != 1 && !fetched)) return E_POINTER;
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
    if (!ppenum) return E_POINTER;
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
  if (!enumCommands) return E_POINTER;
  *enumCommands = nullptr;
  if (kind_ != CommandKind::Root) return E_NOTIMPL;
  auto* commands = new (std::nothrow) EnumCommands();
  if (!commands) return E_OUTOFMEMORY;
  HRESULT hr = commands->Initialize(site_);
  if (FAILED(hr)) {
    commands->Release();
    return hr;
  }
  *enumCommands = commands;
  return S_OK;
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
