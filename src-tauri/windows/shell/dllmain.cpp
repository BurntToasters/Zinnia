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
#include <sddl.h>
#include <string>
#include <vector>
#include <new>
#include <algorithm>
#include <cwchar>
#include <cwctype>
#include <filesystem>
#include "resource.h"

#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "advapi32.lib")

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
static constexpr size_t kMaxPathsPerRequest = 4'096;
static constexpr size_t kMaxHandoffBytes = 4 * 1024 * 1024;

static void AddRefModule() { InterlockedIncrement(&g_moduleRefs); }
static void ReleaseModule() { InterlockedDecrement(&g_moduleRefs); }

static bool EndsWithIgnoreCase(const std::wstring& value, const wchar_t* suffix) {
  const size_t n = wcslen(suffix);
  return value.size() >= n &&
         _wcsicmp(value.c_str() + (value.size() - n), suffix) == 0;
}

static bool LooksLikeArchiveExtension(const std::wstring& lower_or_path) {
  static const wchar_t* kExts[] = {
      L".7z", L".zip", L".rar",  L".tar",  L".gz",
      L".tgz", L".bz2", L".tbz2", L".xz", L".txz"};
  for (const wchar_t* candidate : kExts) {
    if (EndsWithIgnoreCase(lower_or_path, candidate)) return true;
  }
  return false;
}

// Match launch/open_routing.rs: archive.7z.001 / archive.zip.001, or bare
// name.001 when a sibling volume exists.
static bool LooksLikeSplitVolume(const std::wstring& path) {
  std::wstring lower = path;
  for (auto& ch : lower) ch = static_cast<wchar_t>(towlower(ch));
  const size_t dot = lower.find_last_of(L'.');
  if (dot == std::wstring::npos || dot + 1 >= lower.size()) return false;
  const std::wstring suffix = lower.substr(dot + 1);
  if (suffix.size() != 3) return false;
  for (wchar_t ch : suffix) {
    if (ch < L'0' || ch > L'9') return false;
  }
  const std::wstring stem = lower.substr(0, dot);
  if (LooksLikeArchiveExtension(stem)) return true;

  // Bare name.001: the manifest only activates Extract for first volumes, so
  // one .002 probe proves a split set without stalling Explorer on 999 stats.
  if (suffix != L"001") return false;
  std::filesystem::path fs_path(path);
  const auto parent = fs_path.parent_path();
  const auto stem_os = fs_path.stem().wstring();
  if (stem_os.empty()) return false;
  const auto second_volume = parent / (stem_os + L".002");
  std::error_code ec;
  return std::filesystem::exists(second_volume, ec) && !ec;
}

static bool LooksLikeArchive(const std::wstring& path) {
  std::wstring lower = path;
  for (auto& ch : lower) ch = static_cast<wchar_t>(towlower(ch));
  return LooksLikeArchiveExtension(lower) || LooksLikeSplitVolume(path);
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
  if (count > kMaxPathsPerRequest) {
    return HRESULT_FROM_WIN32(ERROR_BUFFER_OVERFLOW);
  }
  DWORD resolved = 0;
  for (DWORD i = 0; i < count; ++i) {
    IShellItem* item = nullptr;
    hr = items->GetItemAt(i, &item);
    if (FAILED(hr) || !item) continue;
    PWSTR path = nullptr;
    hr = item->GetDisplayName(SIGDN_FILESYSPATH, &path);
    if (SUCCEEDED(hr) && path) {
      out->emplace_back(path);
      ++resolved;
      CoTaskMemFree(path);
    }
    item->Release();
  }
  if (resolved != count) {
    out->clear();
    return HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED);
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

// DLL is usually next to zinnia.exe ($INSTDIR). If mapped under a sparse
// `shell-*` payload directory, only the parent install dir is trusted.
static bool DirectoryNameStartsWithShellDash(const std::wstring& name) {
  return name.size() >= 6 && _wcsnicmp(name.c_str(), L"shell-", 6) == 0;
}

static std::wstring GetZinniaExePath() {
  std::vector<wchar_t> buffer(512);
  DWORD length = 0;
  for (;;) {
    SetLastError(ERROR_SUCCESS);
    length = GetModuleFileNameW(g_hInst, buffer.data(),
                                static_cast<DWORD>(buffer.size()));
    if (length == 0) return std::wstring();
    if (length < buffer.size()) break;
    buffer.resize(buffer.size() * 2);
  }

  const std::filesystem::path modulePath(
      std::wstring(buffer.data(), static_cast<size_t>(length)));
  const auto moduleDir = modulePath.parent_path();
  if (DirectoryNameStartsWithShellDash(moduleDir.filename().wstring())) {
    auto candidate = moduleDir.parent_path() / L"zinnia.exe";
    if (GetFileAttributesW(candidate.c_str()) != INVALID_FILE_ATTRIBUTES) {
      return candidate.wstring();
    }
    return std::wstring();
  }

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

// Win11 expects the classic "path,-resourceId" icon resource string.
static HRESULT GetZinniaIconRef(LPWSTR* icon) {
  if (!icon) return E_POINTER;
  std::vector<wchar_t> buffer(MAX_PATH);
  DWORD length = 0;
  for (;;) {
    SetLastError(ERROR_SUCCESS);
    length = GetModuleFileNameW(g_hInst, buffer.data(),
                                static_cast<DWORD>(buffer.size()));
    if (length == 0) break;
    if (length < buffer.size()) {
      std::wstring ref(buffer.data(), static_cast<size_t>(length));
      ref += L",-";
      ref += std::to_wstring(IDI_ZINNIA);
      return SHStrDupW(ref.c_str(), icon);
    }
    buffer.resize(buffer.size() * 2);
  }

  // Fallback: first icon group in zinnia.exe.
  std::wstring exe = GetZinniaExePath();
  exe += L",0";
  return SHStrDupW(exe.c_str(), icon);
}

static std::wstring QuoteArgument(const std::wstring& path) {
  std::wstring quoted = L"\"";
  size_t backslashes = 0;
  for (wchar_t ch : path) {
    if (ch == L'\\') {
      ++backslashes;
      continue;
    }
    if (ch == L'\"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted += ch;
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted += ch;
  }
  quoted.append(backslashes * 2, L'\\');
  quoted += L'\"';
  return quoted;
}

static HRESULT LaunchOneBatch(const std::wstring& exe,
                              const std::wstring& params) {
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

static bool Utf8PathLine(const std::wstring& path, std::string* out) {
  if (!out || path.empty() ||
      path.find_first_of(L"\r\n") != std::wstring::npos) {
    return false;
  }
  const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
      path.data(), static_cast<int>(path.size()), nullptr, 0, nullptr, nullptr);
  if (required <= 0) return false;
  const size_t begin = out->size();
  if (begin > kMaxHandoffBytes ||
      static_cast<size_t>(required) + 1 > kMaxHandoffBytes - begin) {
    return false;
  }
  out->resize(begin + static_cast<size_t>(required));
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, path.data(),
      static_cast<int>(path.size()), out->data() + begin, required,
      nullptr, nullptr) != required) {
    out->resize(begin);
    return false;
  }
  out->push_back('\n');
  return true;
}

// Match Rust fs_secure::is_valid_windows_sid_string before SDDL interpolation.
static bool IsValidWindowsSidString(const std::wstring& sid) {
  constexpr size_t kMaxSidChars = 256;
  if (sid.size() < 7 || sid.size() > kMaxSidChars) return false;
  if (sid.compare(0, 4, L"S-1-") != 0) return false;
  size_t i = 4;
  auto read_digits = [&]() -> bool {
    if (i >= sid.size() || sid[i] < L'0' || sid[i] > L'9') return false;
    while (i < sid.size() && sid[i] >= L'0' && sid[i] <= L'9') ++i;
    return true;
  };
  if (!read_digits()) return false;
  size_t subauths = 0;
  while (i < sid.size()) {
    if (sid[i] != L'-') return false;
    ++i;
    if (!read_digits()) return false;
    ++subauths;
  }
  return subauths >= 1;
}

static HRESULT CurrentUserSidString(std::wstring* sid_text) {
  if (!sid_text) return E_POINTER;
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    return HRESULT_FROM_WIN32(GetLastError());
  }
  DWORD needed = 0;
  if (!GetTokenInformation(token, TokenUser, nullptr, 0, &needed) &&
      GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    const DWORD error = GetLastError();
    CloseHandle(token);
    return HRESULT_FROM_WIN32(error);
  }
  if (needed == 0) {
    CloseHandle(token);
    return E_FAIL;
  }
  std::vector<BYTE> buffer(needed);
  if (!GetTokenInformation(token, TokenUser, buffer.data(), needed, &needed)) {
    const DWORD error = GetLastError();
    CloseHandle(token);
    return HRESULT_FROM_WIN32(error);
  }
  CloseHandle(token);
  const auto* user = reinterpret_cast<TOKEN_USER*>(buffer.data());
  LPWSTR sid_raw = nullptr;
  if (!ConvertSidToStringSidW(user->User.Sid, &sid_raw) || !sid_raw) {
    return HRESULT_FROM_WIN32(GetLastError());
  }
  *sid_text = sid_raw;
  LocalFree(sid_raw);
  if (!IsValidWindowsSidString(*sid_text)) return E_FAIL;
  return S_OK;
}

// Private DACL matching Rust fs_secure::private_directory_sddl: current user
// owner, protected DACL, full control for current user + SYSTEM.
static HRESULT CreatePrivateHandoffSecurityAttributes(
    SECURITY_ATTRIBUTES* attributes, PSECURITY_DESCRIPTOR* descriptor_out) {
  if (!attributes || !descriptor_out) return E_POINTER;
  *descriptor_out = nullptr;
  std::wstring sid;
  HRESULT hr = CurrentUserSidString(&sid);
  if (FAILED(hr)) return hr;
  const std::wstring sddl =
      L"O:" + sid + L"D:P(A;OICI;FA;;;" + sid + L")(A;OICI;FA;;;SY)";
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
          sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) ||
      !descriptor) {
    return HRESULT_FROM_WIN32(GetLastError());
  }
  attributes->nLength = sizeof(SECURITY_ATTRIBUTES);
  attributes->lpSecurityDescriptor = descriptor;
  attributes->bInheritHandle = FALSE;
  *descriptor_out = descriptor;
  return S_OK;
}

// Persist the complete Explorer selection before spawning Zinnia. One command
// launch is then sufficient regardless of selection size, so a later batch
// launch can never partially deliver a request.
static HRESULT WriteShellHandoff(const std::vector<std::wstring>& paths,
                                 std::wstring* handoff_path) {
  if (!handoff_path) return E_POINTER;
  std::string payload;
  for (const auto& path : paths) {
    if (!Utf8PathLine(path, &payload)) {
      return HRESULT_FROM_WIN32(ERROR_FILENAME_EXCED_RANGE);
    }
  }

  DWORD temp_length = GetTempPathW(0, nullptr);
  if (temp_length == 0) return HRESULT_FROM_WIN32(GetLastError());
  std::vector<wchar_t> temp(temp_length + 1);
  if (GetTempPathW(static_cast<DWORD>(temp.size()), temp.data()) == 0) {
    return HRESULT_FROM_WIN32(GetLastError());
  }
  GUID handoff_guid = {};
  HRESULT guid_hr = CoCreateGuid(&handoff_guid);
  if (FAILED(guid_hr)) return guid_hr;
  wchar_t guid_text[40] = {};
  if (StringFromGUID2(handoff_guid, guid_text, 40) == 0) {
    return E_FAIL;
  }
  const std::wstring name = std::wstring(temp.data()) +
      L"zinnia-shell-handoff-" + guid_text + L".tmp";
  SECURITY_ATTRIBUTES attributes = {};
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  HRESULT sec_hr =
      CreatePrivateHandoffSecurityAttributes(&attributes, &descriptor);
  if (FAILED(sec_hr)) return sec_hr;
  // CREATE_NEW avoids a temp-file replacement window before the Rust process
  // validates and consumes the payload. Explicit private SDDL avoids inheriting
  // a world-writable Temp DACL.
  HANDLE file = CreateFileW(name.c_str(), GENERIC_WRITE, 0, &attributes,
      CREATE_NEW, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_WRITE_THROUGH, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    const DWORD create_error = GetLastError();
    LocalFree(descriptor);
    return HRESULT_FROM_WIN32(create_error);
  }
  LocalFree(descriptor);
  DWORD written = 0;
  const bool wrote = payload.size() <= MAXDWORD &&
      WriteFile(file, payload.data(), static_cast<DWORD>(payload.size()), &written, nullptr) &&
      written == payload.size() && FlushFileBuffers(file);
  const DWORD error = wrote ? ERROR_SUCCESS : GetLastError();
  CloseHandle(file);
  if (!wrote) {
    DeleteFileW(name.c_str());
    return HRESULT_FROM_WIN32(error);
  }
  *handoff_path = name;
  return S_OK;
}

static HRESULT LaunchZinnia(const wchar_t* flag,
                            const std::vector<std::wstring>& paths) {
  if (paths.empty()) return E_FAIL;
  if (paths.size() > kMaxPathsPerRequest) {
    return HRESULT_FROM_WIN32(ERROR_BUFFER_OVERFLOW);
  }
  std::wstring exe = GetZinniaExePath();
  if (GetFileAttributesW(exe.c_str()) == INVALID_FILE_ATTRIBUTES) {
    return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
  }

  std::wstring handoff_path;
  HRESULT hr = WriteShellHandoff(paths, &handoff_path);
  if (FAILED(hr)) return hr;
  const std::wstring params = std::wstring(flag) +
      L" --zinnia-shell-handoff " + QuoteArgument(handoff_path);
  hr = LaunchOneBatch(exe, params);
  if (FAILED(hr)) DeleteFileW(handoff_path.c_str());
  return hr;
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
    return GetZinniaIconRef(icon);
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
    if (selection) {
      DWORD count = 0;
      HRESULT countHr = selection->GetCount(&count);
      if (FAILED(countHr)) return countHr;
      // A non-empty selection must resolve in full. Never reinterpret a
      // partial/virtual selection as a background click on the current folder.
      if (count > 0) return GetSelectedPaths(selection, paths);
    }
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
    DWORD selectionCount = 0;
    if (selection && SUCCEEDED(selection->GetCount(&selectionCount)) &&
        selectionCount > kMaxPathsPerRequest) {
      *state = ECS_DISABLED;
      return S_OK;
    }
    if (kind_ == CommandKind::ExtractTop) {
      // Manifest ItemType registration already limits this command to archive
      // extensions. Keep thin Explorer probes enabled so the modern menu does
      // not discard the verb before handing us its real selection. Dynamic state
      // still hides false-positive .001 files and rejects non-archives in Invoke.
      std::vector<std::wstring> paths;
      const bool resolved =
          SUCCEEDED(ResolvePaths(selection, &paths)) && !paths.empty();
      if (!resolved) {
        DWORD count = 0;
        if (selection && SUCCEEDED(selection->GetCount(&count)) && count > 0) {
          *state = ECS_DISABLED;
        }
        return S_OK;
      }
      if (!AllPathsAreArchives(paths)) {
        *state = ECS_HIDDEN;
      }
      return S_OK;
    }
    if (kind_ == CommandKind::Extract) {
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
