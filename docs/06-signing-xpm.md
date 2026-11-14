# 06 · 为什么自建 .so 不可行（XPM）

设备：`<your-device-id>`（BRA-AL00 / HarmonyOS 7.0.0.111 / uitest 7.0.0.1 / arm64）。

## 现象

```sh
uitest start-daemon singleness --extension-name my.so
```

hilog：

```
MUSL-LDSO: Xpm check failed for /data/local/tmp/my.so, errno for mmap is: 13
dlopen ... Permission denied
```

`errno 13` = EACCES，在 **mmap 阶段**被内核拒绝。这是 HarmonyOS 的 XPM（代码完整性校验），不是 SELinux（无 avc 记录）、不是文件权限、不是 ELF 格式问题、也不是 noexec（`/data` 挂载是 `hmfs rw,nosuid,nodev`，**没有 noexec**）。

## 已排除的假设

| 假设 | 实验 | 结果 |
|---|---|---|
| ELF 结构问题 | 改 soname / hash-style / build-id / RELRO | ❌ 仍拒 |
| 文件权限 | `chmod 755` | ❌ 仍拒 |
| 自签名 | `binary-sign-tool.jar -selfSign 1` | ❌ 仍拒 |
| OpenHarmony 官方 release 私钥 | 能签成功 | ❌ 仍拒 |
| 嫁接签名块 | 把 `agent.so` 的 32 B `elf sign block` 尾块贴到自建 ELF | ❌ 仍拒 |
| 路径穿越 | `../../local/tmp/agent.so` | 过 FileExists，加载仍失败 |
| **只改内容不改结构** | 见下表 | ❌ 改 1 字节即失效 |

## 关键实验（2026-11-15，决定性）

在 `/data/local/tmp`，全部 `chmod 755`，直接执行（不经过 dlopen，绕开 loader 层）：

| 变体 | 内容 | 结果 |
|---|---|---|
| `t1_copy.so` | `agent.so` 原样复制 | ✅ **Signal 11**（校验通过，跑起来了） |
| `t2_trunc.so` | `agent.so` 砍掉尾部 32 B 签名块 | ❌ exit=126 `Permission denied` |
| `t3_append.so` | 自编译静态 ELF + 追加那 32 B 签名块 | ❌ exit=126 |
| `t4_text.so` | `agent.so` 改 `.text` 里 **1 个字节** | ❌ exit=126 |
| `t5_rodata.so` | `agent.so` 改 `.rodata` 里 **1 个字节** | ❌ exit=126 |
| `t6_cert.so` | `agent.so` 改**证书区**里 1 个字节 | ❌ exit=126 |
| `probe_static` | 自编译 aarch64 静态 ELF，无签名 | ❌ exit=126 |

**三条结论**：

1. **签名覆盖整个文件内容** —— `.text` / `.rodata` / 连证书区自身改一个字节都失效。所以「嫁接签名块」和「补丁现成 SO」都不可行。
2. **签名块是校验的必需输入**，不是可有可无的标记 —— 砍掉即失效。
3. **静态独立 ELF 和 `.so` 受同一套校验** —— 所以「绕开 dlopen、以独立进程运行自建 C 程序」这条路在真机上**也不成立**。

签名块结构（32 B 尾块）：

```
offset 0   : "elf sign block  "  (16 B，注意两个尾空格)
offset 16  : "1000"              (4 B 版本)
offset 20  : LE uint32 证书长度
offset 24  : LE uint32 版本/保留
offset 28  : 4 B 保留（全 0）
```

证书本体紧邻其前，内含 `Huawei` 字样（`agent.so` 里在 offset 598,409 处）。

## 对照事实

| 文件 | 签名 | 加载 |
|---|---|---|
| `agent.so` | Huawei CBG Software Signing Service CA | ✅ |
| `perfmonitor_260608.so` | 同上（尾部带 `elf sign block`） | ✅ |
| `libscreen_casting.z.so`（6.8 / 7.0） | 同上 | ✅ |
| 任何自编译 .so / ELF | 无 / 自签 / 嫁接 | ❌ |

## 但模拟器没有这道校验

同一份自编译扩展，在模拟器上**能加载并执行**：

```sh
# x86_64，只导出 UiTestExtension_OnInit / UiTestExtension_OnRun
hdc -t 127.0.0.1:5555 file send ext_x86.so /data/local/tmp/ext_x86.so
hdc -t 127.0.0.1:5555 shell "chmod 755 /data/local/tmp/ext_x86.so; \
  uitest start-daemon singleness --extension-name ext_x86.so; \
  cat /data/local/tmp/ext_ran.txt"
# → EXT_RAN
```

| 环境 | 内核 | 未签名 .so 扩展 | 未签名静态 ELF |
|---|---|---|---|
| 真机 BRA-AL00 | HongMeng Kernel 1.13.0 | ❌ XPM 拒绝 | ❌ exit 126 |
| 模拟器 | Linux 5.10.210 | ✅ 正常加载 | ✅ 正常执行 |

**用途**：模拟器可以作为自建扩展的原型验证环境（虚拟屏、AAMS、自定义截图管线等），但**结论不能平移到真机**。

## 真机上唯一可行的自建路径：HAP + 自己的华为账号签名

`hscrcpy` 的 `audio-companion/` 是现成范例：标准 HAP 工程 + `arm64-v8a/libaudio_capture.so`，用 DevEco Studio 配合本机华为账号**自动生成调试签名**，`hdc install -r` 安装后 native 代码跑在应用沙箱内。已在其 VALIDATION.md 记录真机成功。

| 路径 | 需要什么 | 能做到 | 做不到 |
|---|---|---|---|
| uitest 扩展 `.so` | Huawei CBG 签名 | 扩展 uitest 进程 | 拿不到 |
| 独立 ELF | 同上 | 独立进程 | 拿不到 |
| **HAP + 自签名** | **自己的华为账号** | 沙箱内 native、应用权限、无障碍服务 | 碰不到 `/dev/uinput`、碰不到 uitest 内部 |

补充：`/dev/uinput` 实测真机 `Permission denied`、模拟器 `No such file` —— 所以 HarmonyMirror 的 uinput 输入方案在我们的设备上**本来就走不通**，签名只是第二道墙。

## 结论

自建扩展方案的前置条件是拿到 **Huawei CBG Software Signing Service** 签发的证书 + 可用口令。没有这条路，只能：

1. 用现成的华为签名 `.so`（本文档描述的方案）
2. 客户端侧封装（不做设备侧扩展）
3. 模拟器上自建扩展做原型（不能上真机）

当前推荐 **方案 1** —— 三个 `.so` 合起来已经覆盖了绝大部分需求，唯一缺口是窗口级静态截图（见 [05](05-capability-matrix.md)）与虚拟屏/AAMS（见 [08](08-missing-capabilities.md)）。

## 关于「别人怎么解决的」

HarmonyMirror 的 HarmonyAgent 同样**没有解决**：它是静态 ELF，失败时 `deployAndStartAgent()` 只打一行日志就 `return false`，静默回退 `hdc uinput`。详见 [09](09-capability-gaps-roadmap.md) 第二节。
