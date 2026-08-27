# Archive fixtures

Tiny committed archives used by `npm run test:archives`, Cargo sidecar tests, and
Vitest manifest checks. They cover every format Zinnia actually opens or creates,
not the full 7-Zip format list.

## Payload

`hello.txt` contains:

```
zinnia fixture payload
```

The test password for `encrypted.7z` and `encrypted-aes.zip` is `zinnia-test`.

## Regenerating writable fixtures

From the repo root, after `npm run prepare:7z`:

```sh
node scripts/generate-test-archives.js
```

That rebuilds every fixture 7-Zip can write. It does **not** overwrite
`hello.rar` (bundled 7-Zip cannot create RAR). To recreate the RAR4 stored
sample once:

```sh
node scripts/generate-test-archives.js --write-rar
```

## Layout

- Simple extract samples: `hello.{7z,zip,tar,gz,bz2,xz,rar}`
- Compound TAR extract samples: `hello.tar.gz`, `hello.tgz`, `hello.tar.bz2`,
  `hello.tbz2`, `hello.tar.xz`, `hello.txz`
- Path variants: `nested.zip`, `unicode.zip`
- Encrypted: `encrypted.7z` (header encrypt), `encrypted-aes.zip` (AES-256)
- Negative: `not-an-archive.bin` (detection must fail), `truncated.zip` (ZIP
  magic present, extract must fail)

Create coverage (6 formats only) is generated at test time; those outputs are
not committed. Split volumes are also generated in temp (they are too large to
track once `-v` is at least 1 MiB).
