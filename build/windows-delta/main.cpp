// Windows installer patch worker. All paths are supplied by the updater in its
// private staging directory. The patch format never supplies filesystem paths.
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
extern "C" {
#include "Alloc.h"
#include "Lzma2Dec.h"
#include "Lzma2Enc.h"
#include "decompress_plugin_demo.h"
#include "libHDiffPatch/HPatch/patch.h"
}

namespace fs = std::filesystem;
using Bytes = std::vector<unsigned char>;
using Size = uint64_t;
constexpr Size MaxView = 2ull << 30;
constexpr unsigned MaxSegment = 8u << 20;
constexpr unsigned MaxRecords = 100000;

void require(bool ok, const char *message) {
  if (!ok)
    throw std::runtime_error(message);
}

uint32_t readSize(std::istream &in) {
  unsigned char b[4];
  in.read(reinterpret_cast<char *>(b), 4);
  require(in.good(), "truncated record");
  return uint32_t(b[0]) | uint32_t(b[1]) << 8 | uint32_t(b[2]) << 16 |
         uint32_t(b[3]) << 24;
}

void writeRecord(std::ostream &out, char kind, uint32_t n) {
  const unsigned char header[] = {
      static_cast<unsigned char>(kind), static_cast<unsigned char>(n),
      static_cast<unsigned char>(n >> 8), static_cast<unsigned char>(n >> 16),
      static_cast<unsigned char>(n >> 24)};
  out.write(reinterpret_cast<const char *>(header), sizeof(header));
}

void copyBytes(std::istream &in, std::ostream &out, Size count) {
  std::array<char, 65536> buffer;
  while (count) {
    const auto n = std::min<Size>(count, buffer.size());
    in.read(buffer.data(), n);
    require(in.good(), "truncated input");
    out.write(buffer.data(), n);
    count -= n;
  }
}

void basis(const fs::path &original, const fs::path &plan,
           const fs::path &dest) {
  const auto size = fs::file_size(original);
  require(size <= MaxView && fs::file_size(plan) <= 12ull * MaxRecords,
          "basis too large");
  std::ifstream source(original, std::ios::binary),
      rows(plan, std::ios::binary);
  require(source && rows, "cannot read basis inputs");
  std::ofstream output(dest, std::ios::binary);
  output.exceptions(std::ios::badbit | std::ios::failbit);
  Size pos = 0;
  auto literal = [&](Size n) {
    if (n) {
      writeRecord(output, 'R', static_cast<uint32_t>(n));
      copyBytes(source, output, n);
    }
  };
  while (rows.peek() != EOF) {
    auto offset = readSize(rows), packed = readSize(rows),
         expanded = readSize(rows);
    require(offset >= pos && Size(offset) + packed <= size && packed &&
                expanded && packed <= MaxSegment && expanded <= MaxSegment,
            "invalid region");
    require(Size(output.tellp()) + (offset - pos) + expanded + 10 <= MaxView,
            "expanded basis too large");
    literal(offset - pos);
    Bytes input(packed + 1), plain(expanded); // implicit LZMA2 end marker
    source.read(reinterpret_cast<char *>(input.data()), packed);
    require(source.good(), "truncated region");
    size_t used = input.size(), length = plain.size();
    ELzmaStatus status;
    require(Lzma2Decode(plain.data(), &length, input.data(), &used, 16,
                        LZMA_FINISH_END, &status, &g_Alloc) == SZ_OK &&
                length == expanded && used == input.size() &&
                status == LZMA_STATUS_FINISHED_WITH_MARK,
            "invalid LZMA2 region");
    writeRecord(output, 'Z', expanded);
    output.write(reinterpret_cast<char *>(plain.data()), length);
    pos = Size(offset) + packed;
  }
  require(Size(output.tellp()) + size - pos + 5 <= MaxView,
          "basis exceeds limit");
  literal(size - pos);
  output.close();
}

void restore(const fs::path &view, const fs::path &dest, Size limit) {
  require(limit <= MaxView && fs::file_size(view) <= MaxView,
          "installer exceeds limit");
  std::ifstream source(view, std::ios::binary);
  require(source.good(), "cannot open target representation");
  std::ofstream output(dest, std::ios::binary);
  output.exceptions(std::ios::badbit | std::ios::failbit);
  auto destroy = [](CLzma2EncHandle h) { Lzma2Enc_Destroy(h); };
  std::unique_ptr<CLzma2Enc, decltype(destroy)> enc(
      Lzma2Enc_Create(&g_Alloc, &g_BigAlloc), destroy);
  require(enc != nullptr, "encoder allocation failed");
  unsigned records = 0;
  for (int kind; (kind = source.get()) != EOF;) {
    require(++records <= 2 * MaxRecords + 1, "too many records");
    uint32_t n = readSize(source);
    require(n > 0, "empty record");
    const auto remaining = limit - Size(output.tellp());
    if (kind == 'R') {
      require(n <= remaining, "literal exceeds target size");
      copyBytes(source, output, n);
    } else {
      require(kind == 'Z' && n <= MaxSegment, "invalid target segment");
      Bytes plain(n), packed(n + n / 16 + 256);
      source.read(reinterpret_cast<char *>(plain.data()), n);
      require(source.good(), "truncated target segment");
      CLzma2EncProps props;
      Lzma2EncProps_Init(&props);
      props.lzmaProps.level = 9;
      props.lzmaProps.dictSize = 1u << 20;
      props.lzmaProps.reduceSize = n;
      props.numTotalThreads = 2;
      size_t length = packed.size();
      require(Lzma2Enc_SetProps(enc.get(), &props) == SZ_OK,
              "invalid encoder settings");
      Lzma2Enc_SetDataSize(enc.get(), n);
      require(Lzma2Enc_Encode2(enc.get(), nullptr, packed.data(), &length,
                               nullptr, plain.data(), n, nullptr) == SZ_OK &&
                  length > 1 && packed[length - 1] == 0 &&
                  length - 1 <= remaining,
              "cannot reproduce segment");
      output.write(reinterpret_cast<char *>(packed.data()), length - 1);
    }
  }
  require(Size(output.tellp()) == limit, "target size mismatch");
  output.close();
}

struct Input {
  std::ifstream file;
  hpatch_TStreamInput stream{};
  explicit Input(const fs::path &p) : file(p, std::ios::binary) {
    require(file.good(), "cannot open patch input");
    stream.streamSize = fs::file_size(p);
    stream.streamImport = this;
    stream.read = [](const hpatch_TStreamInput *s, hpatch_StreamPos_t pos,
                     unsigned char *b, unsigned char *end) -> hpatch_BOOL {
      auto &f = static_cast<Input *>(s->streamImport)->file;
      f.seekg(pos);
      f.read(reinterpret_cast<char *>(b), end - b);
      return f.good();
    };
  }
};

void patch(const fs::path &basisPath, const fs::path &deltaPath,
           const fs::path &dest) {
  Input old(basisPath), delta(deltaPath);
  hpatch_singleCompressedDiffInfo info{};
  require(getSingleCompressedDiffInfo(&info, &delta.stream, 0) &&
              !std::strcmp(info.compressType, "zstd") &&
              delta.stream.streamSize <= (64u << 20) &&
              old.stream.streamSize <= MaxView &&
              info.oldDataSize == old.stream.streamSize &&
              info.newDataSize <= MaxView && info.coverCount <= MaxView &&
              info.stepMemSize <= (4u << 20) &&
              info.uncompressedSize <= MaxView &&
              info.diffDataPos <= delta.stream.streamSize &&
              info.compressedSize == delta.stream.streamSize - info.diffDataPos,
          "unsupported patch");
  std::ofstream file(dest, std::ios::binary);
  hpatch_TStreamOutput target{};
  target.streamSize = info.newDataSize;
  target.streamImport = &file;
  target.write = [](const hpatch_TStreamOutput *s, hpatch_StreamPos_t pos,
                    const unsigned char *b,
                    const unsigned char *end) -> hpatch_BOOL {
    auto &f = *static_cast<std::ofstream *>(s->streamImport);
    if (Size(f.tellp()) != pos)
      return hpatch_FALSE;
    f.write(reinterpret_cast<const char *>(b), end - b);
    return f.good();
  };
  auto decoder = zstdDecompressPlugin;
  decoder.open = [](hpatch_TDecompress *plugin, hpatch_StreamPos_t size,
                    const hpatch_TStreamInput *stream, hpatch_StreamPos_t start,
                    hpatch_StreamPos_t end) -> hpatch_decompressHandle {
    auto handle = _zstd_open(plugin, size, stream, start, end);
    if (handle && ZSTD_isError(ZSTD_DCtx_setParameter(
                      static_cast<_zstd_TDecompress *>(handle)->s,
                      ZSTD_d_windowLogMax, 25))) {
      _zstd_close(plugin, handle);
      return nullptr;
    }
    return handle;
  };
  Bytes cache(size_t(info.stepMemSize) + (8u << 20));
  require(patch_single_compressed_diff(
              &target, &old.stream, &delta.stream, info.diffDataPos,
              info.uncompressedSize, info.compressedSize, &decoder,
              info.coverCount, info.stepMemSize, cache.data(),
              cache.data() + cache.size(), nullptr, 1),
          "invalid patch");
  require(Size(file.tellp()) == info.newDataSize, "incomplete patch output");
  file.close();
  require(file.good(), "patch output write failed");
}

#ifdef _WIN32
int wmain(int argc, wchar_t **argv) {
#else
int main(int argc, char **argv) {
#endif
  try {
    require(argc == 5, "expected mode and three arguments");
    fs::path mode(argv[1]);
    if (mode == "basis")
      basis(argv[2], argv[3], argv[4]);
    else if (mode == "patch")
      patch(argv[2], argv[3], argv[4]);
    else if (mode == "restore")
      restore(argv[2], argv[3], std::stoull(argv[4]));
    else
      throw std::runtime_error("unknown mode");
    return 0;
  } catch (const std::exception &e) {
    std::cerr << e.what() << '\n';
    return 1;
  }
}
