import {
  createIcons,
  Settings,
  Heart,
  FolderOpen,
  Folder,
  Package,
  File,
  ArrowLeft,
  Eye,
  ArchiveRestore,
  Trash2,
  FilePlus,
  FolderPlus,
  Check,
  AlertTriangle,
  Sliders,
  Monitor,
  Info,
  RotateCcw,
} from "lucide";

export function refreshIcons() {
  createIcons({
    icons: {
      Settings,
      Heart,
      FolderOpen,
      Folder,
      Package,
      File,
      ArrowLeft,
      Eye,
      ArchiveRestore,
      Trash2,
      FilePlus,
      FolderPlus,
      Check,
      AlertTriangle,
      Sliders,
      Monitor,
      Info,
      RotateCcw,
    },
    attrs: {
      "aria-hidden": "true",
    },
  });
}
