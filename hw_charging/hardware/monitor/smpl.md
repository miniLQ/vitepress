---
outline: deep
---

# SMPL 模块分析

## 一、模块概述

### 1.1 功能定位
**SMPL (Sudden Momentary Power Loss，瞬时掉电)** 是华为 MATE X5 电源管理系统中的**瞬时掉电异常监控模块**，专门用于检测和记录设备因瞬时电压跌落导致的意外重启事件，通过分析重启原因并上报 DMD（Device Monitor Diagnosis）告警，帮助定位电源系统故障。

### 1.2 核心功能
- **重启原因识别**：通过 Kernel Cmdline 参数识别 SMPL 重启事件
- **多模式检测**：支持 4 种不同的 SMPL 标识字符串
- **自动 DMD 上报**：检测到 SMPL 后自动上报告警信息
- **电池状态采集**：记录重启时的电池品牌、温度、电压、电量等关键信息
- **延迟检测**：系统启动 10 秒后执行检测，确保电池信息可用

### 1.3 设计背景
SMPL 是一种常见的电源系统故障现象，表现为系统运行中突然断电重启。常见原因包括：
- **电池老化**：内阻升高，负载电流冲击时电压跌落严重
- **电池接触不良**：BTB 连接器松动，瞬间断开导致掉电
- **充电 IC 故障**：输出能力不足，无法提供足够的瞬时电流
- **PMIC 保护**：过流/欠压保护误触发导致系统复位
- **硬件设计缺陷**：电源路径阻抗过大，压降过大

通过监控 SMPL 事件并记录关键信息，可以帮助：
- 分析电源系统故障模式
- 识别批次性硬件问题
- 指导售后维修策略
- 优化电源系统设计

---

## 二、系统架构

### 2.1 模块组成
```
smpl 模块
├── smpl.c          # 主逻辑（重启原因检测、DMD 上报）
├── smpl.h          # 数据结构定义
├── Kconfig         # 内核配置
└── Makefile        # 编译配置
```

### 2.2 架构分层
```
+---------------------------------------------------------------+
|                    Bootloader (U-Boot/ABL)                    |
|  检测重启原因 → 设置 Kernel Cmdline 参数                       |
|  - normal_reset_type=SMPL                                     |
|  - reboot_reason=power_loss                                   |
|  - reboot_reason=2sec_reboot                                  |
|  - normal_reset_type=BR_POWERON_BY_SMPL                       |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|                    Kernel (smpl.c)                            |
|  1. 启动 10 秒后执行检测                                       |
|  2. 解析 Cmdline 参数识别 SMPL                                |
|  3. 采集电池状态信息                                           |
|  4. 上报 DMD 告警                                             |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|                    DMD System (Device Monitor)                |
|  - 错误码: POWER_DSM_ERROR_NO_SMPL                            |
|  - 错误类型: POWER_DSM_SMPL                                   |
|  - 告警内容: 电池品牌、温度、电压、电量                         |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|                    Cloud Analysis Platform                    |
|  - 统计 SMPL 发生频率                                         |
|  - 分析故障模式                                                |
|  - 生成维修建议                                                |
+---------------------------------------------------------------+
```

### 2.3 工作流程
```
设备启动
    ↓
Kernel 初始化
    ↓
smpl_init() 执行
    ↓
创建延迟工作队列（10 秒）
    ↓
等待 10 秒（确保电池驱动就绪）
    ↓
smpl_error_monitor_work() 执行
    ↓
┌─────────────────────────────────────────────────┐
│  检查 Kernel Cmdline 参数                        │
│  1. strstr("normal_reset_type=SMPL")            │
│  2. strstr("reboot_reason=power_loss")          │
│  3. strstr("reboot_reason=2sec_reboot")         │
│  4. strstr("normal_reset_type=BR_POWERON_BY_SMPL") │
└─────────────────────────────────────────────────┘
    ↓
发现 SMPL 标识？
    ├─ 否 → 退出（正常启动）
    └─ 是 → 继续
        ↓
采集电池状态信息
    ├─ 电池品牌: power_supply_app_get_bat_brand()
    ├─ 电池温度: power_supply_app_get_bat_temp()
    ├─ 电池电压: power_supply_app_get_bat_voltage_now()
    └─ 电池电量: power_supply_app_get_bat_capacity()
    ↓
构造 DMD 告警字符串
    ↓
上报 DMD
    ↓
记录日志
    ↓
完成
```

---

## 三、核心数据结构

### 3.1 设备管理结构
```c
struct smpl_dev {
    struct device *dev;              // 设备节点（未使用）
    struct delayed_work monitor_work; // 延迟工作队列
};
```

**说明**：
- 该模块非常简洁，仅包含一个延迟工作队列用于启动后检测
- 无需 DTS 配置、Sysfs 接口等复杂功能

### 3.2 常量定义
```c
#define DELAY_TIME_FOR_MONITOR_WORK 10000  // 10 秒延迟
```

**设计意图**：
- 延迟 10 秒确保电池驱动、充电驱动等已完全初始化
- 避免启动早期读取电池信息失败

---

## 四、核心算法与工作流程

### 4.1 重启原因检测算法（smpl_check_reboot_reason）

```c
static bool smpl_check_reboot_reason(void)
{
    // 检测方式 1: normal_reset_type=SMPL（高通平台）
    if (strstr(saved_command_line, "normal_reset_type=SMPL")) {
        hwlog_info("smpl happened: normal_reset_type=smpl\n");
        return true;
    }
    
    // 检测方式 2: reboot_reason=power_loss（MTK 平台）
    if (strstr(saved_command_line, "reboot_reason=power_loss")) {
        hwlog_info("smpl happened: reboot_reason=power_loss\n");
        return true;
    }
    
    // 检测方式 3: reboot_reason=2sec_reboot（特殊情况）
    if (strstr(saved_command_line, "reboot_reason=2sec_reboot")) {
        hwlog_info("smpl happened: reboot_reason=2sec_reboot\n");
        return true;
    }
    
    // 检测方式 4: BR_POWERON_BY_SMPL（华为自研平台）
    if (strstr(saved_command_line, "normal_reset_type=BR_POWERON_BY_SMPL")) {
        hwlog_info("smpl happened: normal_reset_type=BR_POWERON_BY_SMPL\n");
        return true;
    }
    
    return false;  // 未检测到 SMPL
}
```

**Cmdline 参数来源**：
- Bootloader（U-Boot/ABL）在启动时检测 PMIC 寄存器
- PMIC 记录上次关机/重启原因（PONSTS/PON_REASON 寄存器）
- Bootloader 将原因编码为 Cmdline 参数传递给 Kernel

**四种检测模式对应平台**：
1. `normal_reset_type=SMPL`：高通平台（Qualcomm）
2. `reboot_reason=power_loss`：MTK 平台（MediaTek）
3. `reboot_reason=2sec_reboot`：特殊场景（连续快速重启）
4. `normal_reset_type=BR_POWERON_BY_SMPL`：华为自研平台（Kirin/HiSilicon）

### 4.2 SMPL 监控工作流程（smpl_error_monitor_work）

```c
static void smpl_error_monitor_work(struct work_struct *work)
{
    char buf[POWER_DSM_BUF_SIZE_0128] = { 0 };
    
    hwlog_info("monitor_work begin\n");
    
    // 1. 检查是否发生 SMPL
    if (!smpl_check_reboot_reason())
        return;  // 未发生 SMPL，直接退出
    
    // 2. 采集电池状态信息并构造告警字符串
    snprintf(buf, POWER_DSM_BUF_SIZE_0128 - 1,
        "smpl happened : brand=%s t_bat=%d, volt=%d, soc=%d\n",
        power_supply_app_get_bat_brand(),        // 电池品牌（如 "ATL", "SUNWODA"）
        power_supply_app_get_bat_temp(),         // 电池温度（0.1°C，如 250 = 25.0°C）
        power_supply_app_get_bat_voltage_now(),  // 电池电压（mV，如 3850）
        power_supply_app_get_bat_capacity());    // 电池电量（%，如 65）
    
    // 3. 上报 DMD 告警
    power_dsm_report_dmd(POWER_DSM_SMPL,
        POWER_DSM_ERROR_NO_SMPL, buf);
    
    // 4. 记录日志
    hwlog_info("smpl happened: %s\n", buf);
}
```

**DMD 告警格式示例**：
```
smpl happened : brand=ATL t_bat=250, volt=3850, soc=65
```

**信息解读**：
- `brand=ATL`：使用 ATL 电池
- `t_bat=250`：电池温度 25.0°C
- `volt=3850`：电池电压 3850mV (3.85V)
- `soc=65`：电池电量 65%

### 4.3 模块初始化流程（smpl_init）

```c
static int __init smpl_init(void)
{
    struct smpl_dev *l_dev = NULL;
    
    // 1. 分配设备结构内存
    l_dev = kzalloc(sizeof(*l_dev), GFP_KERNEL);
    if (!l_dev)
        return -ENOMEM;
    
    g_smpl_dev = l_dev;
    
    // 2. 初始化延迟工作队列
    INIT_DELAYED_WORK(&l_dev->monitor_work, smpl_error_monitor_work);
    
    // 3. 调度延迟 10 秒后执行
    schedule_delayed_work(&l_dev->monitor_work,
        msecs_to_jiffies(DELAY_TIME_FOR_MONITOR_WORK));
    
    return 0;
}
```

**初始化时机**：`module_init()`
- 在 Kernel 模块初始化阶段执行
- 通常在系统启动后 1-2 秒内完成
- 10 秒延迟后执行检测（总时间约 11-12 秒）

### 4.4 模块退出流程（smpl_exit）

```c
static void __exit smpl_exit(void)
{
    if (!g_smpl_dev)
        return;
    
    // 取消延迟工作队列
    cancel_delayed_work(&g_smpl_dev->monitor_work);
    
    // 释放内存
    kfree(g_smpl_dev);
    g_smpl_dev = NULL;
}
```

---

## 五、典型应用场景

### 5.1 场景1：电池老化导致的 SMPL

```
用户场景：
设备使用 2 年，电池老化，内阻升高

触发过程：
1. 用户运行大型游戏（高功耗负载）
   ↓
2. CPU/GPU 突发功耗峰值 6W
   ↓
3. 电池瞬时放电电流 2A
   ↓
4. 电池内阻 300mΩ（新电池约 100mΩ）
   ↓
5. 压降 = 2A × 0.3Ω = 0.6V
   ↓
6. VBAT 从 3.8V 跌落至 3.2V
   ↓
7. PMIC 欠压保护触发（阈值 3.3V）
   ↓
8. 系统复位重启（SMPL 事件）
   ↓
9. Bootloader 检测到 PMIC PONSTS 寄存器 = SMPL
   ↓
10. 设置 Cmdline: normal_reset_type=SMPL
    ↓
11. Kernel 启动，smpl 模块检测到 SMPL
    ↓
12. 上报 DMD：
    brand=ATL t_bat=350 volt=3200 soc=45
    ↓
13. 分析结论：
    - 电压 3200mV 过低
    - 电量 45% 不应该出现 SMPL
    - 怀疑电池老化
```

### 5.2 场景2：BTB 接触不良导致的 SMPL

```
用户场景：
设备跌落后，电池连接器松动

触发过程：
1. 用户手机意外跌落
   ↓
2. BTB 连接器受冲击松动
   ↓
3. 接触电阻从 5mΩ 升至 100mΩ
   ↓
4. 正常使用中，瞬间断开 → 重新接触
   ↓
5. 电池断开瞬间 → VBAT = 0V
   ↓
6. PMIC 检测到掉电 → 系统复位
   ↓
7. BTB 重新接触 → 电池恢复供电
   ↓
8. 设备自动重启（SMPL 事件）
   ↓
9. Bootloader 设置 Cmdline: reboot_reason=power_loss
   ↓
10. smpl 模块检测并上报：
    brand=SUNWODA t_bat=280 volt=3900 soc=78
    ↓
11. 分析结论：
    - 电压 3900mV 正常
    - 电量 78% 充足
    - 温度 28°C 正常
    - 怀疑机械故障（BTB/电池接触不良）
```

### 5.3 场景3：充电 IC 故障导致的 SMPL

```
用户场景：
充电过程中系统突然重启

触发过程：
1. 用户边充电边玩游戏
   ↓
2. 充电 IC 输出电流 = 充电电流 + 系统负载
   ↓
3. 充电 IC 内部 MOSFET 异常（批次缺陷）
   ↓
4. 输出电流能力下降至 1A（正常应 3A）
   ↓
5. 系统负载突增至 2A
   ↓
6. 充电 IC 过流保护触发 → 输出关断
   ↓
7. VSYS 跌落 → 系统掉电
   ↓
8. SMPL 重启
   ↓
9. Bootloader 设置 Cmdline: normal_reset_type=BR_POWERON_BY_SMPL
   ↓
10. smpl 模块上报：
    brand=ATL t_bat=420 volt=4100 soc=85
    ↓
11. 分析结论：
    - 电池状态良好
    - 充电中发生（电压 4.1V 为充电电压）
    - 温度 42°C 偏高（充电 + 游戏发热）
    - 怀疑充电 IC 或电源路径故障
```

### 5.4 场景4：连续快速 SMPL（2sec_reboot）

```
用户场景：
设备启动过程中反复重启

触发过程：
1. 设备首次 SMPL 重启
   ↓
2. Bootloader 启动 → Kernel 加载
   ↓
3. 系统初始化过程中再次触发 SMPL
   ↓
4. 连续重启时间 < 2 秒
   ↓
5. Bootloader 检测到连续重启
   ↓
6. 设置 Cmdline: reboot_reason=2sec_reboot
   ↓
7. smpl 模块检测到异常重启模式
   ↓
8. 上报 DMD：
    brand=ATL t_bat=150 volt=3100 soc=2
    ↓
9. 分析结论：
    - 电量仅 2%（临界低电量）
    - 电压 3100mV（关机阈值附近）
    - 温度 15°C（低温环境）
    - 启动电流峰值导致电压跌落
    - 建议进入低电量保护模式
```

---

## 六、调试方法

### 6.1 日志关键点
```bash
# 1. 模块初始化日志
[smpl] monitor_work begin

# 2. SMPL 检测日志（4 种模式）
[smpl] smpl happened: normal_reset_type=smpl
[smpl] smpl happened: reboot_reason=power_loss
[smpl] smpl happened: reboot_reason=2sec_reboot
[smpl] smpl happened: normal_reset_type=BR_POWERON_BY_SMPL

# 3. DMD 上报日志
[smpl] smpl happened: brand=ATL t_bat=250, volt=3850, soc=65
```

### 6.2 Cmdline 参数查看
```bash
# 查看完整 Kernel Cmdline
cat /proc/cmdline

# 查看是否包含 SMPL 标识
cat /proc/cmdline | grep -E "SMPL|power_loss|2sec_reboot"

# 示例输出：
# ... normal_reset_type=SMPL ...
```

### 6.3 PMIC 寄存器查看
```bash
# 不同平台寄存器路径不同

# 高通平台
cat /sys/kernel/debug/pmic-debug/pon_reason

# MTK 平台
cat /sys/kernel/debug/mtk-pmic/pon_reason

# 华为平台
cat /sys/kernel/debug/hi6xxx-pmic/pon_reason
```

### 6.4 DMD 查询
```bash
# 查看 DMD 上报记录
cat /sys/kernel/debug/power_dsm/power_dsm_dump | grep SMPL

# 或查看 logcat
logcat -b events | grep SMPL
```

### 6.5 手动触发测试
```bash
# 修改 Cmdline 测试（需要 root 权限）
# 注意：仅用于开发调试，不应在量产版本使用

# 方法 1: 在 Bootloader 中添加参数
# U-Boot 命令行：
setenv bootargs "${bootargs} normal_reset_type=SMPL"
boot

# 方法 2: 修改 DTB 中的 bootargs（需要重新编译）
# 在 DTS 中添加：
chosen {
    bootargs = "... normal_reset_type=SMPL";
};
```

### 6.6 常见问题排查

#### 问题1：SMPL 未检测到
**现象**：设备明显重启但无 SMPL 日志

**排查步骤**：
1. 检查 Cmdline 参数：
   ```bash
   cat /proc/cmdline
   ```
2. 检查 PMIC 驱动是否正确设置参数
3. 检查 smpl 模块是否加载：
   ```bash
   lsmod | grep smpl
   dmesg | grep smpl
   ```

#### 问题2：电池信息为空
**现象**：DMD 上报中电池信息为 0 或空

**排查步骤**：
1. 检查延迟时间是否足够：
   ```c
   // 增加延迟时间
   #define DELAY_TIME_FOR_MONITOR_WORK 20000  // 改为 20s
   ```
2. 检查电池驱动是否已初始化：
   ```bash
   cat /sys/class/power_supply/battery/voltage_now
   cat /sys/class/power_supply/battery/capacity
   ```

#### 问题3：频繁 SMPL 告警
**现象**：DMD 系统频繁收到 SMPL 告警

**排查步骤**：
1. 分析 DMD 数据趋势：
   - 电压分布（是否集中在低电压区）
   - 电量分布（是否集中在低电量区）
   - 温度分布（是否在极端温度）
   - 电池品牌分布（是否特定批次）

2. 硬件排查：
   ```bash
   # 检查电池健康度
   cat /sys/class/power_supply/battery/health
   
   # 检查电池循环次数
   cat /sys/class/power_supply/battery/cycle_count
   
   # 检查电池阻抗
   cat /sys/class/power_supply/battery/resistance
   ```

3. 软件优化：
   - 优化功耗峰值控制
   - 调整 PMIC 欠压保护阈值
   - 改善电源管理策略

---

## 七、SMPL 故障分析方法

### 7.1 数据分析维度

#### 电压维度
| VBAT 范围 | 可能原因 | 处理建议 |
|-----------|----------|----------|
| < 3000mV | 极低电量，电池耗尽 | 低电量保护优化 |
| 3000-3200mV | 电池老化，内阻高 | 更换电池 |
| 3200-3500mV | 负载过大，电压跌落 | 功耗优化 |
| 3500-3800mV | BTB 接触不良 | 硬件检修 |
| > 3800mV | 充电中 SMPL | 充电 IC 故障 |

#### 电量维度
| SOC 范围 | 可能原因 | 处理建议 |
|----------|----------|----------|
| 0-5% | 正常低电量关机 | 提前低电量保护 |
| 5-15% | 电池老化严重 | 电池健康度检测 |
| 15-50% | 电池或硬件故障 | 硬件检修 |
| > 50% | 充电 IC/BTB 故障 | 硬件更换 |

#### 温度维度
| 温度范围 | 可能原因 | 处理建议 |
|----------|----------|----------|
| < 0°C | 低温电池性能下降 | 低温保护优化 |
| 0-15°C | 温和环境，其他故障 | 硬件检查 |
| 15-40°C | 正常温度范围 | 其他原因分析 |
| > 40°C | 高负载发热 | 温控优化 |

### 7.2 故障模式分类

#### 模式1：电池老化型
**特征**：
- 电压 3000-3300mV
- 电量 30-60%
- 温度正常
- 频繁发生

**处理**：建议用户更换电池

#### 模式2：接触不良型
**特征**：
- 电压正常（3500-4000mV）
- 电量充足（> 50%）
- 随机发生
- 可能伴随跌落

**处理**：检查 BTB 连接器

#### 模式3：低温型
**特征**：
- 温度 < 5°C
- 电量中等（20-50%）
- 电压偏低（3200-3500mV）

**处理**：优化低温保护策略

#### 模式4：充电故障型
**特征**：
- 电压 > 3900mV（充电电压）
- 电量递增趋势
- 充电中发生

**处理**：检查充电 IC 和电源路径

---

## 八、总结

### 8.1 技术特点
1. **轻量级设计**：模块极简，无复杂依赖
2. **延迟检测**：10 秒延迟确保依赖服务就绪
3. **多平台兼容**：支持高通、MTK、华为等平台
4. **信息丰富**：记录电池关键状态便于分析

### 8.2 设计亮点
- **被动监控**：不主动干预系统，仅记录和上报
- **启动检测**：在系统启动阶段完成检测，不影响运行时性能
- **多模式识别**：覆盖不同平台和场景的 SMPL 标识
- **DMD 集成**：自动上报云端，支持大数据分析

### 8.3 应用价值
- **故障定位**：快速识别电源系统问题根因
- **质量改进**：通过大数据分析发现批次缺陷
- **售后支持**：为用户维修提供诊断依据
- **产品优化**：指导下一代产品的电源设计

### 8.4 局限性
- **信息有限**：仅记录静态信息，无法获取 SMPL 瞬间的动态数据
- **无实时监控**：仅启动时检测，无法监控运行时状态
- **依赖 Bootloader**：必须依赖 Bootloader 正确设置 Cmdline
- **无主动防护**：仅监控上报，不具备 SMPL 预防能力

### 8.5 改进方向
1. **增强信息采集**：
   - 记录 PMIC 寄存器快照
   - 采集 SMPL 前的系统负载信息
   - 记录充电状态和电流

2. **实时监控**：
   - 监控电池电压/电流波动
   - 检测电压跌落趋势
   - 预警潜在 SMPL 风险

3. **主动防护**：
   - 低电量时限制功耗峰值
   - 低温时降低性能避免电压跌落
   - 老化电池检测并告警
