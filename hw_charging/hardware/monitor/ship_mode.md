---
outline: deep
---


# Ship Mode 模块分析

## 一、模块概述

### 1.1 功能定位
**Ship Mode (运输模式)** 是华为 MATE X5 电源管理系统中的**设备运输/仓储模式控制模块**，主要用于在设备出厂运输或长期仓储期间，**将电池与系统负载隔离**，防止电池因系统静态漏电流而缓慢放电，确保设备在长时间存储后仍能正常启动。

### 1.2 核心功能
- **电池隔离**：通过充电 IC 内部开关断开电池与系统的连接
- **延迟进入**：支持配置延迟时间（默认 15s），留出时间供用户取消操作
- **工厂模式适配**：工厂模式下缩短延迟时间（5s）加快测试流程
- **操作权限管理**：区分 Shell、AT 命令、HIDL 等不同操作来源
- **关机触发**：支持在系统关机时自动进入 Ship Mode
- **多 IC 适配**：支持 Platform 默认 IC 和其他第三方 IC

### 1.3 设计背景
在设备生产后到用户开机前，可能经历数周甚至数月的运输和仓储时间。即使设备处于关机状态，系统仍存在微小的静态漏电流（通常 100-500μA）。以 4000mAh 电池为例：
- 静态功耗：300μA
- 放电时间：4000mAh / 0.3mA ≈ 13333 小时 ≈ **555 天**
- 实际存储：考虑自放电和温度影响，约 **3-6 个月**后电池可能耗尽

**Ship Mode 的作用**：
- 将电池与系统完全隔离，静态功耗降至几乎为 0
- 延长存储期限至 **2 年以上**
- 用户首次插入充电器或按电源键时自动退出 Ship Mode

---

## 二、系统架构

### 2.1 模块组成
```
ship_mode 模块
├── ship_mode.c         # 主控制逻辑（参数管理、接口注册）
├── ship_mode.h         # 数据结构定义
├── Kconfig             # 内核配置
└── Makefile            # 编译配置
```

### 2.2 架构分层
```
+---------------------------------------------------------------+
|                    User Space (Sysfs/HIDL)                    |
|  /sys/class/hw_power/ship_mode/                               |
|    ├─ work_mode (读写)                                         |
|    ├─ entry_time (只读)                                        |
|    └─ delay_time (只读)                                        |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              Ship Mode Core (ship_mode.c)                     |
|  - ship_mode_entry(): 进入 Ship Mode                          |
|  - ship_mode_ops_register(): 注册 IC 操作接口                 |
|  - 参数管理: entry_time, delay_time, work_mode                |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              IC Abstraction Layer (ship_mode_ops)             |
|  - set_entry_time(): 设置进入时间                              |
|  - set_work_mode(): 设置工作模式                               |
+---------------------------------------------------------------+
                              ↓
+---------------------------------------------------------------+
|              Hardware IC Driver Layer                         |
|  Platform IC:                                                 |
|    - Charger IC (如 BQ25970, SC8989X)                        |
|    - PMIC (如 HI6421, HI6555)                                |
|  Other IC:                                                    |
|    - 第三方充电管理芯片                                         |
+---------------------------------------------------------------+
```

### 2.3 工作流程
```
触发 Ship Mode
    ↓
┌─────────────────────────────────────────────────┐
│  方式 1: Sysfs 手动触发                          │
│  echo "shell 1" > work_mode                     │
│                                                 │
│  方式 2: AT 命令触发                             │
│  echo "atcmd 1" > work_mode                     │
│                                                 │
│  方式 3: HIDL 接口触发                           │
│  echo "hidl 1" > work_mode                      │
│                                                 │
│  方式 4: 关机触发（预设 work_mode=2）            │
│  系统关机 → ship_mode_shutdown()                │
└─────────────────────────────────────────────────┘
    ↓
ship_mode_entry() 执行
    ↓
┌─────────────────────────────────────────────────┐
│  1. 设置进入时间（可选）                          │
│     set_entry_time(entry_time)                  │
│     - 用户模式: 15s                              │
│     - 工厂模式: 5s                               │
│                                                 │
│  2. 设置工作模式                                 │
│     set_work_mode(work_mode)                    │
│     - SHIP_MODE_IN_SHIP (1)                     │
│                                                 │
│  3. 延迟等待（防抖）                             │
│     msleep(delay_time)                          │
│     - 默认: 3ms                                  │
└─────────────────────────────────────────────────┘
    ↓
充电 IC 执行隔离操作
    ↓
┌─────────────────────────────────────────────────┐
│  硬件操作（由 IC Driver 实现）                   │
│  1. 写入 IC 寄存器配置 Ship Mode                 │
│  2. 启动定时器（entry_time 秒后）                │
│  3. 定时器到期 → 断开 BATFET（电池开关）         │
│  4. 电池与系统完全隔离                            │
└─────────────────────────────────────────────────┘
    ↓
设备进入 Ship Mode
    ↓
┌─────────────────────────────────────────────────┐
│  退出条件（由硬件自动检测）:                      │
│  - 插入充电器 → VBUS 上电 → 退出 Ship Mode       │
│  - 按电源键 → PWRKEY 信号 → 退出 Ship Mode       │
└─────────────────────────────────────────────────┘
```

---

## 三、核心数据结构

### 3.1 Ship Mode 参数
```c
struct ship_mode_para {
    unsigned int delay_time;     // 操作延迟时间（ms，默认 3ms）
    unsigned int entry_time;     // 进入等待时间（s）
                                 //   用户模式: 15s
                                 //   工厂模式: 5s
    unsigned int work_mode;      // 工作模式
};
```

### 3.2 工作模式枚举
```c
enum ship_mode_work_mode {
    SHIP_MODE_NOT_IN_SHIP,       // 0: 未进入 Ship Mode（正常模式）
    SHIP_MODE_IN_SHIP,           // 1: 进入 Ship Mode（立即执行）
    SHIP_MODE_IN_SHUTDOWN_SHIP,  // 2: 关机时进入 Ship Mode（延迟执行）
};
```

**模式说明**：
- **NOT_IN_SHIP (0)**：正常工作模式，退出 Ship Mode
- **IN_SHIP (1)**：立即进入 Ship Mode（Sysfs 写入后立即执行）
- **IN_SHUTDOWN_SHIP (2)**：预设关机进入模式（仅在系统关机时执行）

### 3.3 操作用户枚举
```c
enum ship_mode_op_user {
    SHIP_MODE_OP_USER_SHELL,     // Shell 命令行操作
    SHIP_MODE_OP_USER_ATCMD,     // AT 命令或 Diag 守护进程
    SHIP_MODE_OP_USER_HIDL,      // HIDL 接口（Android HAL）
};
```

**权限控制**：不同用户来源可以在未来扩展不同的权限策略。

### 3.4 IC 类型枚举
```c
enum ship_mode_ic_type {
    SHIP_MODE_IC_TYPE_PLATFORM,  // 0: 平台默认 IC（如华为 PMIC）
    SHIP_MODE_IC_TYPE_OTHER,     // 1: 其他第三方 IC
};
```

### 3.5 IC 操作接口
```c
struct ship_mode_ops {
    const char *ops_name;        // 操作名称（用于日志识别）
    void *dev_data;              // 设备私有数据指针
    
    // 设置进入时间（可选实现）
    void (*set_entry_time)(unsigned int time, void *dev_data);
    
    // 设置工作模式（必须实现）
    void (*set_work_mode)(unsigned int mode, void *dev_data);
};
```

**设计模式**：策略模式（Strategy Pattern）
- 定义统一接口，支持多种 IC 实现
- 运行时根据 `ops_type` 选择对应的 ops

### 3.6 设备管理结构
```c
struct ship_mode_dev {
    struct device *dev;                           // Sysfs 设备节点
    struct ship_mode_ops *ops[SHIP_MODE_IC_TYPE_END];  // IC 操作接口数组
    struct ship_mode_para para;                   // Ship Mode 参数
    int ops_type;                                 // 当前使用的 IC 类型
};
```

---

## 四、核心算法与工作流程

### 4.1 IC 操作接口注册（ship_mode_ops_register）

```c
int ship_mode_ops_register(struct ship_mode_ops *ops, int type)
{
    // 1. 参数校验
    if (!g_ship_mode_dev || !ops || !ops->ops_name) {
        hwlog_err("g_ship_mode_dev or ops or ops_name is null\n");
        return -EPERM;
    }
    
    // 2. IC 类型校验
    if ((type < SHIP_MODE_IC_TYPE_BEGIN) || (type >= SHIP_MODE_IC_TYPE_END)) {
        hwlog_err("ship mode ic type is invalid\n");
        return -EINVAL;
    }
    
    // 3. 防止重复注册
    if (g_ship_mode_dev->ops[type]) {
        hwlog_err("ops[%d] exist, register failed\n", type);
        return -EPERM;
    }
    
    // 4. 保存 ops 指针
    g_ship_mode_dev->ops[type] = ops;
    
    hwlog_info("%s ops register ok, type=%d\n", ops->ops_name, type);
    return 0;
}
```

**使用示例**（在充电 IC 驱动中）：
```c
static struct ship_mode_ops bq25970_ship_ops = {
    .ops_name = "bq25970",
    .dev_data = bq_dev,
    .set_entry_time = bq25970_set_ship_entry_time,
    .set_work_mode = bq25970_set_ship_work_mode,
};

// 在充电 IC probe 函数中注册
ship_mode_ops_register(&bq25970_ship_ops, SHIP_MODE_IC_TYPE_PLATFORM);
```

### 4.2 进入 Ship Mode 核心流程（ship_mode_entry）

```c
int ship_mode_entry(const struct ship_mode_para *para)
{
    struct ship_mode_dev *l_dev = ship_mode_get_dev();
    struct ship_mode_ops *l_ops = ship_mode_get_ops();
    
    // 1. 参数校验
    if (!l_dev || !para)
        return -EINVAL;
    
    // 2. 检查 ops 是否已注册
    if (!l_ops || !l_ops->set_work_mode) {
        hwlog_err("l_ops or set_work_mode is null\n");
        return -EINVAL;
    }
    
    hwlog_info("entry: entry_time=%u work_mode=%u delay_time=%u\n",
        para->entry_time, para->work_mode, para->delay_time);
    
    // 3. 设置进入时间（如果 IC 支持）
    if (l_ops->set_entry_time)
        l_ops->set_entry_time(para->entry_time, l_ops->dev_data);
    
    // 4. 设置工作模式（触发 Ship Mode）
    l_ops->set_work_mode(para->work_mode, l_ops->dev_data);
    
    // 5. 延迟等待（防抖，默认 3ms）
    power_msleep(para->delay_time, 0, NULL);
    
    return 0;
}
```

**执行时序**：
```
T0: ship_mode_entry() 调用
    ↓
T0+0: set_entry_time(15s)     // IC 内部启动 15s 定时器
    ↓
T0+0: set_work_mode(1)        // IC 写入 Ship Mode 使能位
    ↓
T0+3ms: msleep(3ms) 完成      // 软件延迟
    ↓
T0+15s: IC 定时器到期         // 硬件断开 BATFET
    ↓
T0+15s: 电池隔离完成          // 设备进入 Ship Mode
```

### 4.3 获取 IC 操作接口（ship_mode_get_ops）

```c
static struct ship_mode_ops *ship_mode_get_ops(void)
{
    struct ship_mode_dev *l_dev = ship_mode_get_dev();
    
    if (!l_dev)
        return NULL;
    
    // 检查 ops_type 合法性
    if ((l_dev->ops_type < SHIP_MODE_IC_TYPE_BEGIN) ||
        (l_dev->ops_type >= SHIP_MODE_IC_TYPE_END)) {
        hwlog_err("ship mode ic type is invalid\n");
        return NULL;
    }
    
    // 返回对应 IC 类型的 ops
    return l_dev->ops[l_dev->ops_type];
}
```

**多 IC 支持机制**：
- DTS 配置 `ops_type = 0` → 使用 Platform IC
- DTS 配置 `ops_type = 1` → 使用 Other IC
- 运行时通过 `ops_type` 索引选择对应的 ops

### 4.4 DTS 参数解析（ship_mode_parse_dts）

```c
static void ship_mode_parse_dts(struct device_node *np,
    struct ship_mode_dev *l_dev)
{
    // 1. 根据启动模式设置进入时间
    if (power_cmdline_is_factory_mode())
        // 工厂模式: 5 秒
        power_dts_read_str2int(np, "entry_time_fac",
            &l_dev->para.entry_time, SHIP_MODE_DEFAULT_ENTRY_TIME_FAC);
    else
        // 用户模式: 15 秒
        power_dts_read_str2int(np, "entry_time_user",
            &l_dev->para.entry_time, SHIP_MODE_DEFAULT_ENTRY_TIME_USER);
    
    // 2. 读取 IC 类型（默认 Platform IC）
    power_dts_read_u32(np, "ops_type",
        (u32 *)&l_dev->ops_type, SHIP_MODE_IC_TYPE_PLATFORM);
    
    // 3. 读取延迟时间（默认 3ms）
    power_dts_read_str2int(np, "delay_time",
        &l_dev->para.delay_time, SHIP_MODE_DEFAULT_DELAY_TIME);
}
```

**工厂模式判断**：
- 通过 Kernel Cmdline 参数判断：`androidboot.huawei_swtype=factory`
- 工厂模式下缩短等待时间加快测试流程

---

## 五、Sysfs 接口

### 5.1 节点路径
```bash
/sys/class/hw_power/ship_mode/
├── delay_time    # 只读：操作延迟时间（ms）
├── entry_time    # 只读：进入等待时间（s）
└── work_mode     # 读写：工作模式
```

### 5.2 接口说明

#### delay_time（只读）
```bash
cat /sys/class/hw_power/ship_mode/delay_time
# 返回值：3（默认 3ms）
```

#### entry_time（只读）
```bash
cat /sys/class/hw_power/ship_mode/entry_time
# 用户模式返回：15（15 秒）
# 工厂模式返回：5（5 秒）
```

#### work_mode（读写）
```bash
# 读取当前模式
cat /sys/class/hw_power/ship_mode/work_mode
# 返回值：
# 0 = SHIP_MODE_NOT_IN_SHIP（正常模式）
# 1 = SHIP_MODE_IN_SHIP（已进入 Ship Mode）
# 2 = SHIP_MODE_IN_SHUTDOWN_SHIP（关机时进入）

# 写入格式：<user> <value>
# user: shell/atcmd/hidl
# value: 0/1/2

# Shell 命令行进入 Ship Mode
echo "shell 1" > /sys/class/hw_power/ship_mode/work_mode

# AT 命令进入 Ship Mode
echo "atcmd 1" > /sys/class/hw_power/ship_mode/work_mode

# HIDL 接口进入 Ship Mode
echo "hidl 1" > /sys/class/hw_power/ship_mode/work_mode

# 设置关机时进入 Ship Mode
echo "shell 2" > /sys/class/hw_power/ship_mode/work_mode
```

**写入逻辑**：
```c
case SHIP_MODE_SYSFS_WORK_MODE:
    // 1. 校验 work_mode 值
    if ((value != SHIP_MODE_NOT_IN_SHIP) && 
        (value != SHIP_MODE_IN_SHIP) &&
        (value != SHIP_MODE_IN_SHUTDOWN_SHIP)) {
        hwlog_err("invalid value=%d\n", value);
        return -EINVAL;
    }
    
    // 2. 保存到设备参数
    l_dev->para.work_mode = value;
    
    // 3. 立即执行（mode=1）或延迟到关机（mode=2）
    if ((value != SHIP_MODE_IN_SHUTDOWN_SHIP) &&
        ship_mode_entry(&l_dev->para))
        return -EINVAL;
    
    break;
```

**关键点**：
- `work_mode = 1`：写入后**立即执行** Ship Mode 进入流程
- `work_mode = 2`：仅保存参数，**关机时执行**（在 `ship_mode_shutdown()` 中触发）

---

## 六、典型应用场景

### 6.1 场景1：出厂运输（工厂模式）

```
工厂生产线流程：
1. 设备组装完成，电池安装
   ↓
2. 开机进入工厂测试模式
   ↓
3. 执行各项硬件测试
   ↓
4. 测试完成，准备装箱运输
   ↓
5. 执行 Ship Mode 进入命令
   echo "shell 1" > /sys/class/hw_power/ship_mode/work_mode
   ↓
6. 等待 5 秒（entry_time_fac = 5）
   ↓
7. 充电 IC 断开 BATFET
   ↓
8. 设备关机，电池隔离
   ↓
9. 装箱运输（可存储 2 年以上）
   ↓
10. 用户收货，插入充电器或按电源键
    ↓
11. VBUS/PWRKEY 信号触发，IC 自动退出 Ship Mode
    ↓
12. 设备正常开机
```

**时间对比**：
- 工厂模式：5 秒（加快生产节拍）
- 用户模式：15 秒（防止误操作）

### 6.2 场景2：仓储管理（用户模式）

```
仓库长期存储场景：
1. 设备在仓库积压 6 个月
   ↓
2. 管理员定期巡检，发现设备电量下降
   ↓
3. 决定启用 Ship Mode 延长存储寿命
   ↓
4. ADB 连接设备执行命令
   adb shell
   echo "shell 1" > /sys/class/hw_power/ship_mode/work_mode
   ↓
5. 等待 15 秒（可取消）
   ↓
6. 设备进入 Ship Mode
   ↓
7. 可存储 2 年以上不耗电
```

### 6.3 场景3：自动化测试（AT 命令）

```
自动化测试脚本：
1. 测试设备通过 Modem AT 命令控制
   ↓
2. 发送 AT 命令进入 Ship Mode
   AT+SHIPMODE=1
   ↓
3. AT 命令守护进程写入 Sysfs
   echo "atcmd 1" > /sys/class/hw_power/ship_mode/work_mode
   ↓
4. 设备自动进入 Ship Mode
   ↓
5. 测试完成，插入充电器退出
```

### 6.4 场景4：关机自动进入（延迟模式）

```
用户关机场景：
1. 用户长按电源键关机
   ↓
2. Framework 层设置 Ship Mode（预设）
   echo "shell 2" > /sys/class/hw_power/ship_mode/work_mode
   ↓
3. work_mode = 2 被保存，但不立即执行
   ↓
4. 系统执行正常关机流程
   ↓
5. Kernel 调用 ship_mode_shutdown()
   ↓
6. 检测到 work_mode == SHIP_MODE_IN_SHUTDOWN_SHIP
   ↓
7. 执行 ship_mode_entry()
   ↓
8. IC 断开 BATFET
   ↓
9. 设备完全关机并隔离电池
```

**应用场景**：
- 设备需要长期存放（如维修备用机）
- 防止关机后仍有静态漏电

---

## 七、DTS 配置说明

### 7.1 完整配置示例
```dts
ship_mode {
    compatible = "huawei,ship_mode";
    status = "ok";
    
    /* IC 类型：0=Platform, 1=Other */
    ops_type = <0>;
    
    /* 用户模式进入时间（秒） */
    entry_time_user = <15>;
    
    /* 工厂模式进入时间（秒） */
    entry_time_fac = <5>;
    
    /* 操作延迟时间（毫秒） */
    delay_time = <3>;
};
```

### 7.2 参数说明

| 参数名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| ops_type | u32 | 0 | IC 类型<br>0=Platform IC, 1=Other IC |
| entry_time_user | s32 | 15 | 用户模式进入等待时间（秒） |
| entry_time_fac | s32 | 5 | 工厂模式进入等待时间（秒） |
| delay_time | s32 | 3 | 操作延迟时间（毫秒） |

### 7.3 配置策略

#### 不同产品配置
```dts
/* 高端旗舰机（长存储周期） */
entry_time_user = <20>;   // 更长的取消时间，防止误操作
entry_time_fac = <3>;     // 工厂快速测试

/* 中低端产品（快速周转） */
entry_time_user = <10>;   // 缩短等待时间
entry_time_fac = <5>;     // 标准工厂配置

/* 第三方充电 IC */
ops_type = <1>;           // 使用 Other IC 类型
```

---

## 八、调试方法

### 8.1 日志关键点
```bash
# 1. ops 注册日志
[ship_mode] bq25970 ops register ok, type=0

# 2. 进入 Ship Mode 日志
[ship_mode] entry: entry_time=15 work_mode=1 delay_time=3

# 3. Sysfs 写入日志
[ship_mode] set: name=2, user=shell, value=1

# 4. 参数调试日志
[ship_mode] delay_time=3
[ship_mode] entry_time=15

# 5. 错误日志
[ship_mode] invalid value=3
[ship_mode] l_ops or set_work_mode is null
```

### 8.2 Sysfs 调试
```bash
# 查看当前配置
cat /sys/class/hw_power/ship_mode/entry_time
cat /sys/class/hw_power/ship_mode/delay_time
cat /sys/class/hw_power/ship_mode/work_mode

# 测试进入 Ship Mode（15 秒后生效）
echo "shell 1" > /sys/class/hw_power/ship_mode/work_mode
# 注意：执行后 15 秒内可通过重启或插充电器取消

# 查看 IC 寄存器（验证是否写入）
# 具体命令取决于充电 IC 类型，如：
cat /sys/kernel/debug/bq25970/ship_mode_reg
```

### 8.3 Power Debug 接口
```bash
# 查看当前参数
cat /sys/kernel/debug/power/ship_mode/para
# 输出：
# delay_time=3
# entry_time=15

# 修改参数（调试用）
echo "10 20" > /sys/kernel/debug/power/ship_mode/para
# 格式：<delay_time> <entry_time>

# 重新查看
cat /sys/kernel/debug/power/ship_mode/para
# 输出：
# delay_time=10
# entry_time=20
```

### 8.4 常见问题排查

#### 问题1：Ship Mode 未进入
**现象**：写入 work_mode 后设备未进入 Ship Mode

**排查步骤**：
1. 检查 ops 是否注册：
   ```bash
   dmesg | grep "ops register"
   # 应该看到 "xxx ops register ok"
   ```
2. 检查充电 IC 驱动是否加载：
   ```bash
   lsmod | grep charger
   ```
3. 检查 IC 寄存器是否写入：
   ```bash
   # 使用 IC 特定的调试接口查看
   cat /sys/kernel/debug/<ic_name>/registers
   ```
4. 检查 entry_time 是否已过：
   ```bash
   # 等待足够时间（默认 15 秒）
   sleep 20
   ```

#### 问题2：工厂模式未生效
**现象**：工厂模式下 entry_time 仍为 15 秒

**排查步骤**：
1. 检查启动参数：
   ```bash
   cat /proc/cmdline | grep swtype
   # 应该包含 androidboot.huawei_swtype=factory
   ```
2. 检查 DTS 配置：
   ```bash
   cat /proc/device-tree/ship_mode/entry_time_fac
   ```

#### 问题3：无法退出 Ship Mode
**现象**：插入充电器后设备仍无响应

**排查步骤**：
1. 检查充电器是否正常（VBUS 有输出）
2. 尝试长按电源键（10 秒以上）
3. 检查 IC 是否支持 PWRKEY 唤醒
4. 联系硬件工程师检查电路

#### 问题4：误触发 Ship Mode
**现象**：设备意外进入 Ship Mode

**排查步骤**：
1. 检查是否有异常进程写入 Sysfs：
   ```bash
   logcat | grep ship_mode
   ```
2. 检查 SELinux 权限配置：
   ```bash
   ls -Z /sys/class/hw_power/ship_mode/work_mode
   ```
3. 添加权限控制防止误操作

---

## 九、硬件实现示例

### 9.1 充电 IC 中的 Ship Mode 实现

以 TI BQ25970 为例：

```c
/* BQ25970 Ship Mode 寄存器定义 */
#define BQ25970_REG_SHIP_MODE        0x3E
#define BQ25970_SHIP_MODE_ENABLE     BIT(7)
#define BQ25970_SHIP_MODE_ENTRY_TIME 0x0F  // 低 4 位配置时间

/* 设置进入时间 */
static void bq25970_set_ship_entry_time(unsigned int time, void *dev_data)
{
    struct bq25970_dev *bq_dev = dev_data;
    u8 val;
    
    /* 时间转换：秒 → 寄存器值（每单位 1 秒） */
    val = (time > 15) ? 15 : time;
    
    /* 写入寄存器 */
    bq25970_write_mask(bq_dev, BQ25970_REG_SHIP_MODE,
        BQ25970_SHIP_MODE_ENTRY_TIME, 0x0F, val);
    
    hwlog_info("set ship entry_time=%u\n", time);
}

/* 设置工作模式 */
static void bq25970_set_ship_work_mode(unsigned int mode, void *dev_data)
{
    struct bq25970_dev *bq_dev = dev_data;
    u8 enable = (mode == SHIP_MODE_IN_SHIP) ? 1 : 0;
    
    /* 写入使能位 */
    bq25970_write_mask(bq_dev, BQ25970_REG_SHIP_MODE,
        BQ25970_SHIP_MODE_ENABLE, 0x80, enable << 7);
    
    hwlog_info("set ship work_mode=%u (enable=%u)\n", mode, enable);
}

/* 注册 ops */
static struct ship_mode_ops bq25970_ship_ops = {
    .ops_name = "bq25970",
    .dev_data = bq_dev,
    .set_entry_time = bq25970_set_ship_entry_time,
    .set_work_mode = bq25970_set_ship_work_mode,
};

static int bq25970_probe(struct i2c_client *client)
{
    ...
    /* 注册 Ship Mode ops */
    ship_mode_ops_register(&bq25970_ship_ops, SHIP_MODE_IC_TYPE_PLATFORM);
    ...
}
```

### 9.2 硬件电路原理

```
电池 (VBAT) ──┬── BATFET ──┬── VSYS (系统供电)
              │            │
              │            └── 充电器输入 (VBUS)
              │
              └── Fuel Gauge (电量计)

Ship Mode 流程：
1. 正常模式：BATFET 导通，VBAT → VSYS
2. 进入 Ship Mode：IC 断开 BATFET
3. 电池隔离：VBAT 与 VSYS 断开，仅充电器可供电
4. 退出条件：
   - VBUS 插入 → IC 检测到 VBUS → 自动闭合 BATFET
   - PWRKEY 长按 → IC 检测到按键 → 闭合 BATFET
```

---

## 十、总结

### 10.1 技术特点
1. **硬件隔离**：通过充电 IC BATFET 物理断开电池
2. **延迟机制**：提供取消窗口（5-15 秒）防止误操作
3. **多场景适配**：工厂/用户模式自动切换
4. **接口抽象**：支持多种充电 IC 的统一管理

### 10.2 设计亮点
- **安全设计**：延迟进入机制避免误触发
- **灵活配置**：DTS 可配置时间参数适配不同产品
- **权限管理**：区分操作来源（Shell/AT/HIDL）
- **关机集成**：支持系统关机时自动进入

### 10.3 应用价值
- **延长存储寿命**：2 年以上长期存储不耗电
- **降低售后成本**：减少因电池耗尽导致的客诉
- **提升用户体验**：开箱即用，无需预充电
- **优化供应链**：延长设备库存周期

### 10.4 适用场景
- **出厂运输**：新机从工厂到仓库到零售商
- **长期仓储**：备用机、展示机、维修机
- **跨国物流**：海运/空运运输周期长
- **季节性产品**：节日促销后的库存积压
