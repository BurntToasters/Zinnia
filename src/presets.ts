import { $ } from "./utils";

export interface PresetConfig {
  format: string;
  level: string;
  method: string;
  dict: string;
  wordSize: string;
  solid: string;
}

export const PRESETS: Record<string, PresetConfig> = {
  store: { format: "zip", level: "0", method: "deflate", dict: "16m", wordSize: "16", solid: "off" },
  quick: { format: "zip", level: "1", method: "deflate", dict: "16m", wordSize: "32", solid: "off" },
  balanced: { format: "7z", level: "5", method: "lzma2", dict: "64m", wordSize: "64", solid: "4g" },
  high: { format: "7z", level: "7", method: "lzma2", dict: "128m", wordSize: "64", solid: "16g" },
  ultra: { format: "7z", level: "9", method: "lzma2", dict: "512m", wordSize: "128", solid: "solid" },
};

export function updateCompressionOptionsForFormat(format: string) {
  const methodSelect = $<HTMLSelectElement>("method");
  const dictSelect = $<HTMLSelectElement>("dict");
  const wordSizeSelect = $<HTMLSelectElement>("word-size");
  const solidSelect = $<HTMLSelectElement>("solid");
  const levelSelect = $<HTMLSelectElement>("level");

  const currentMethod = methodSelect.value;
  const currentDict = dictSelect.value;
  const currentWordSize = wordSizeSelect.value;
  const currentSolid = solidSelect.value;
  const currentLevel = levelSelect.value;

  const validMethods: Record<string, string[]> = {
    "7z": ["lzma2", "lzma", "ppmd", "bzip2"],
    "zip": ["deflate", "bzip2", "lzma"],
    "tar": [],
    "gzip": [],
    "bzip2": [],
    "xz": []
  };

  const methods = validMethods[format] || [];

  methodSelect.innerHTML = "";
  if (methods.length > 0) {
    methods.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m === "lzma2" ? "LZMA2" :
                        m === "lzma" ? "LZMA" :
                        m === "ppmd" ? "PPMd" :
                        m === "bzip2" ? "BZip2" :
                        m === "deflate" ? "Deflate" :
                        m === "zstd" ? "Zstandard" : m;
      methodSelect.appendChild(opt);
    });
    if (methods.includes(currentMethod)) {
      methodSelect.value = currentMethod;
    }
    methodSelect.disabled = false;
  } else {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "N/A";
    methodSelect.appendChild(opt);
    methodSelect.disabled = true;
  }

  if (currentDict) {
    dictSelect.value = currentDict;
  }

  if (currentWordSize) {
    wordSizeSelect.value = currentWordSize;
  }

  if (currentSolid) {
    solidSelect.value = currentSolid;
  }

  if (format === "tar" || format === "gzip" || format === "bzip2" || format === "xz") {
    if (currentLevel === "0") {
      levelSelect.value = "5";
    }
  }
}

export function applyPreset(name: string) {
  if (name === "custom") return;
  const preset = PRESETS[name];
  if (!preset) return;

  $<HTMLSelectElement>("format").value = preset.format;
  updateCompressionOptionsForFormat(preset.format);
  $<HTMLSelectElement>("level").value = preset.level;
  $<HTMLSelectElement>("method").value = preset.method;
  $<HTMLSelectElement>("dict").value = preset.dict;
  $<HTMLSelectElement>("word-size").value = preset.wordSize;
  $<HTMLSelectElement>("solid").value = preset.solid;
}

export function detectPreset(): string {
  const format = $<HTMLSelectElement>("format").value;
  const level = $<HTMLSelectElement>("level").value;
  const method = $<HTMLSelectElement>("method").value;
  const dict = $<HTMLSelectElement>("dict").value;
  const wordSize = $<HTMLSelectElement>("word-size").value;
  const solid = $<HTMLSelectElement>("solid").value;

  for (const [name, p] of Object.entries(PRESETS)) {
    if (p.format === format && p.level === level && p.method === method &&
        p.dict === dict && p.wordSize === wordSize && p.solid === solid) {
      return name;
    }
  }
  return "custom";
}

export function onCompressionOptionChange() {
  $<HTMLSelectElement>("preset").value = detectPreset();
}
