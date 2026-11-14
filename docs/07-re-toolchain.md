# 07 · 逆向方法与工具链

REA 的原生路径在本机不可用（无 MCP server、无 Ghidra/IDA），改用 **capstone + pyelftools** 自建静态分析管线。所有脚本在 `.work/tools/`，用 `cd .work && python tools/<x>.py <so> ...` 运行。

## 工具清单

| 脚本 | 作用 |
|---|---|
| `strs.py` | 按最小长度 dump ASCII 字符串（带文件偏移） |
| `minidbg.py` | 解 `.gnu_debugdata`（LZMA）→ 独立 ELF（含完整 `.symtab`） |
| `dumpsyms.py` | 列出 `STT_FUNC`（地址/大小/名字） |
| `armdis.py` | capstone ARM64 反汇编，带符号/PLT 注解 |
| `plt2.py` | **正确的** PLT → 符号映射 |
| `xref.py` | rodata 字符串地址 → 引用它的函数 |
| `refdata.py` | 读 `.data.rel.ro` 的 qword 并解析符号 |
| `eorconst.py` | 从 `mov/movk` + `eor` 比较反推 SSO 常量字符串 |
| `sso3.py` / `stackemu.py` / `imm.py` | 栈模拟，重建 `std::string` SSO 值 |
| `findbl.py` | 找 `bl` 到某地址的所有调用点 |

## 关键技术点

### 1. `.gnu_debugdata` 是金矿

`perfmonitor.so` 和 `libscreen_casting.z.so` 都带 `.gnu_debugdata` —— LZMA 压缩的 mini debuginfo，里面是**完整的 `.symtab`**。

```python
import lzma
from elftools.elf.elffile import ELFFile
sec = ELFFile(open(path,'rb')).get_section_by_name('.gnu_debugdata')
open('x.minidebug','wb').write(lzma.decompress(sec.data()))
```

恢复出的符号包含 C++ lambda 的 mangled name，直接暴露源码结构（例如 `_ZN9RpcServer17ScrcpyServiceImpl7onStartE...`）。

`agent.so` **没有** `.gnu_debugdata`，但有 `.dynsym`（704 项），够用。

### 2. PLT → 符号必须解码 GOT

**不要**假设 `.rela.plt` 的顺序等于 PLT 条目顺序 —— 那样会得到完全错误的符号名（第一版就踩了：`0x4d930` 被标成 `istream>>int`，实际是 `IsScrcpyRunning`）。

正确做法是解码每个 16 字节 stub：

```
adrp x16, page
ldr  x17, [x16, #imm]
add  x16, x16, #imm2
br   x17
```

```python
if (w0 & 0x9f00001f) == 0x90000010:      # adrp x16
    immlo = (w0 >> 29) & 3
    immhi = (w0 >> 5) & 0x7ffff
    imm = (immhi << 2) | immlo
    if imm & (1 << 20): imm -= 1 << 21
    adrp = ((base + off) & ~0xfff) + (imm << 12)
    slot = adrp + ((w1 >> 10) & 0xfff) * 8     # ldr x17,[x16,#imm]
    nm = gotmap.get(slot)                       # gotmap: rela.plt r_offset -> dynsym name
```

### 3. `std::string` SSO 布局

短串（≤22 字节）：byte 0 = `(len << 1) | 1`，字符从 byte 1 开始。
长串：`+8` = ptr，`+16` = len。

栈上构造的字符串要靠 `mov/movk` 拼 64 位立即数 + `strb` 写长度，`sso3.py`/`eorconst.py` 做这件事。

### 4. protobuf descriptor 手工解码

`libscreen_casting.z.so` 里的 `descriptor_table_scrcpy_2eproto` 是原始 FileDescriptorProto 字节。写个 varint walker 就能还原字段号/类型/名字，再用 `devicetest` 包里的 `scrcpy_pb2.py` 做**逐字节交叉验证** —— 结果完全一致。

### 5. 运行时验证不可省略

静态分析给出了接口形状，但下面这些只有跑起来才知道：

- `-m 0` vs `-m 1` 决定 socket 名（静态看不出）
- `onEnd` 的粘性副作用
- `-frameRate` 只认 15/30/60/120（静态只看到 `120/fps` 的除法）
- `-s` 才是 saveFrame，`-saveFrame` 不是合法参数
- `Driver.screenCap` 的 fd 在裸 socket 上拿不到

**验证手段**：`hilog -x | grep DevEcoScrcpy` 能拿到 `parse_params` 的完整回显，这是确认参数语义最快的方法。

## 本机环境坑

| 坑 | 解法 |
|---|---|
| 无 `strings`/`readelf`/`objdump`/`nm` | 用 DevEco 的 `llvm-readelf.exe`，或 `tools/strs.py` |
| 脚本名 `dis.py` 遮蔽 stdlib `dis` → 循环 import | 改名 `armdis.py` |
| `python -I` 丢掉 user site-packages → `ModuleNotFoundError: elftools` | 不加 `-I` |
| `cd` 不跨调用保持 | 每条命令前缀 `cd /e/CodeE/vibe51/uitest_agent/.work &&` |
| 无 `pip` 网络（`SSL: UNEXPECTED_EOF_WHILE_READING`） | 从已装的 devicetest 包复制 `scrcpy_pb2*.py`，改一行 import |
| 无 `ffmpeg`/`ffprobe` | 手写 MP4 box walker 解析 `ftyp/mdat/moov/stbl` |
| `hdc hilog -x \| grep` 会挂 | 一律加 `timeout 15` |
| 设备无 `awk`/`tr` | 用 Python 侧处理，或在 shell 里用 `sed -E` |

## 快速复现流程

```bash
cd /e/CodeE/vibe51/uitest_agent/.work

# 1. 解符号
python tools/minidbg.py ../.spike/libscreen_casting.z.so
python tools/dumpsyms.py libscreen_casting.z.so.minidebug | grep RpcServer

# 2. 看某函数
python tools/armdis.py ../.spike/libscreen_casting.z.so 0x1aff8 60

# 3. 解 PLT
python tools/plt2.py ../.spike/agent_pushed.so | grep StartService

# 4. 找字符串引用
python tools/xref.py ../.spike/libscreen_casting.z.so "Server Listening"
```
