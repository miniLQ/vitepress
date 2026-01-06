---
outline: deep
---

# USB PD 协议

## 一、模块定位与核心价值

### 1.1 模块概述

**adapter_protocol_pd** 是华为 MATE X5 快充系统中的 **PD (USB Power Delivery) 协议适配层模块**，作为 adapter_protocol 抽象层的协议实现之一，负责桥接 USB Type-C PD 协议栈与华为充电框架，实现 PD 快充功能。

### 1.2 核心功能
- **协议桥接**：连接 USB Type-C TCPM 层和华为充电框架
- **电压控制**：通过 PD 协议调节适配器输出电压
- **硬复位**：提供 PD Hard Reset 功能
- **状态管理**：维护 PD 适配器当前电压状态
- **轻量级实现**：极简设计，仅提供必要接口

### 1.3 模块特点
- **极简设计**: 仅 217 行代码，是所有协议实现中最精简的
- **桥接角色**: 不直接操作硬件，委托给 USB Type-C 子系统
- **无寄存器操作**: 通过 TCPM (Type-C Port Manager) 间接控制
- **标准 PD 协议**: 遵循 USB-IF PD 3.0/2.0 规范
- **4 种芯片支持**: SCHARGER_V600、FUSB3601、RT1711H、FUSB30X

---

## 二、系统架构设计

### 2.1 模块分层架构

```
┌─────────────────────────────────────────────────────────────┐
│         Charging Framework (Direct Charge)                  │
│         (调用 adapter_protocol 统一接口)                      │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│         adapter_protocol.c (协议路由层)                      │
│         [根据 ADAPTER_PROTOCOL_PD 分发]                      │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┬───────────────┐
         │             │             │               │
    ┌────▼───┐   ┌────▼───┐   ┌────▼───┐     ┌────▼───┐
    │   PD   │   │   SCP  │   │  FCP   │ ... │  UFCS  │
    └────┬───┘   └────────┘   └────────┘     └────────┘
         │
┌────────▼──────────────────────────────────────────────────┐
│  adapter_protocol_pd.c (PD 协议适配层)                     │
│  ┌──────────────────────────────────────────────────┐     │
│  │ • 轻量级包装 (仅 4 个接口)                          │     │
│  │ • 状态维护 (电压缓存)                               │     │
│  │ • 委托转发给 USB Type-C 子系统                      │     │
│  └──────────────────────────────────────────────────┘     │
└────────┬──────────────────────────────────────────────────┘
         │ 调用
┌────────▼──────────────────────────────────────────────────┐
│  USB Type-C Subsystem (oem-typec-adapter.c)               │
│  ┌──────────────────────────────────────────────────┐     │
│  │ • hisi_usb_typec_issue_hardreset()               │     │
│  │ • hisi_usb_typec_set_pd_adapter_voltage()        │     │
│  └──────────────────────────────────────────────────┘     │
└────────┬──────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────────────────────────────────┐
│  TCPM (Type-C Port Manager)                               │
│  • PD Policy Engine                                       │
│  • Protocol Layer (Message Handling)                      │
│  • Physical Layer (TCPC Driver)                           │
└────────┬──────────────────────────────────────────────────┘
         │
         ▼
    USB Type-C Port (TCPC Hardware)
         │
         ▼
    PD Adapter (USB PD 充电器)
```

### 2.2 PD vs SCP/FCP 对比

| **特性** | **PD** | **SCP** | **FCP** |
|---------|--------|---------|---------|
| **协议标准** | USB-IF 标准 | 华为私有 | 华为私有 |
| **代码规模** | 217 行 | 2590 行 | 818 行 |
| **通信方式** | USB Type-C CC 线 | D+/D- 线 | D+/D- 线 |
| **电压调节** | PDO 协商 (离散) | 连续调节 (1mV) | 离散档位 (5V/9V/12V) |
| **功率范围** | 15W~240W | 25W~135W | 18W~36W |
| **复杂度** | 极简（委托） | 高（完整实现） | 中（完整实现） |
| **硬件依赖** | TCPM 子系统 | 直接寄存器操作 | 直接寄存器操作 |
| **认证机制** | USB 认证 | Hash 加密 | 无 |

### 2.3 数据流向

```
充电请求 (设置 9V)
    │
    ├─→ adapter_set_output_voltage(ADAPTER_PROTOCOL_PD, 9000)
    │
    ├─→ hwpd_set_output_voltage(9000)
    │       ├─ 缓存电压: g_hwpd_dev->volt = 9000
    │       └─ 调用 ops: p_ops->set_output_voltage(9000, dev_data)
    │
    ├─→ hisi_usb_typec_set_pd_adapter_voltage(9000)
    │       └─ 调用 TCPM API
    │
    ├─→ TCPM Policy Engine
    │       ├─ 构造 Request Message (9V PDO)
    │       └─ 发送给 PD 适配器
    │
    └─→ PD Adapter
            └─ 切换输出到 9V

Hard Reset 流程
    │
    ├─→ adapter_hard_reset_master(ADAPTER_PROTOCOL_PD)
    │
    ├─→ hwpd_hard_reset_master()
    │       └─ 调用 ops: p_ops->hard_reset_master(dev_data)
    │
    ├─→ hisi_usb_typec_issue_hardreset()
    │       └─ 调用 TCPM API
    │
    ├─→ TCPM Policy Engine
    │       └─ 发送 Hard Reset 信号
    │
    └─→ PD Adapter
            └─ 复位到默认 5V
```

---

## 三、核心数据结构

### 3.1 设备管理结构

```c
struct hwpd_dev {
    struct device *dev;             // 设备对象（未使用）
    struct hwpd_ops *p_ops;         // 操作接口指针
    int volt;                       // 当前电压缓存 (mV)
    int dev_id;                     // 设备 ID (PROTOCOL_DEVICE_ID_xxx)
};
```

**字段说明**:
- `volt`: 初始化为 9000mV (9V)，记录当前 PD 电压
- `dev_id`: 用于标识具体芯片平台

### 3.2 硬件操作接口

```c
struct hwpd_ops {
    const char *chip_name;          // 芯片名称 "scharger_v600"
    void *dev_data;                 // 硬件层私有数据
    
    /* PD 硬复位 */
    void (*hard_reset_master)(void *dev_data);
    
    /* PD 电压设置 */
    void (*set_output_voltage)(int volt, void *dev_data);
};
```

**接口特点**:
- **无返回值**: 函数均为 `void`，假设操作总是成功
- **极简设计**: 仅 2 个核心功能
- **委托实现**: 实际功能由 USB Type-C 子系统完成

### 3.3 设备映射表

```c
static const struct adapter_protocol_device_data g_hwpd_dev_data[] = {
    { PROTOCOL_DEVICE_ID_SCHARGER_V600, "scharger_v600" },
    { PROTOCOL_DEVICE_ID_FUSB3601,      "fusb3601" },
    { PROTOCOL_DEVICE_ID_RT1711H,       "rt1711h" },
    { PROTOCOL_DEVICE_ID_FUSB30X,       "fusb30x" },
};
```

**支持芯片**:
- **SCHARGER_V600**: 华为海思自研电源管理芯片
- **FUSB3601**: ON Semiconductor USB PD 控制器
- **RT1711H**: Richtek USB PD TCPC 芯片
- **FUSB30X**: ON Semiconductor 旧版 PD 芯片

---

## 四、核心功能实现

### 4.1 电压控制

#### 4.1.1 设置输出电压

```c
static int hwpd_set_output_voltage(int volt)
{
    struct hwpd_ops *l_ops = hwpd_get_ops();
    
    if (!l_ops || !l_ops->set_output_voltage) {
        hwlog_err("set_output_voltage is null\n");
        return -EPERM;
    }
    
    hwlog_info("set output voltage: %d\n", volt);
    
    /* Step 1: 缓存电压值 */
    g_hwpd_dev->volt = volt;
    
    /* Step 2: 委托给 USB Type-C 子系统 */
    l_ops->set_output_voltage(volt, l_ops->dev_data);
    
    return 0;
}
```

**实现特点**:
- **状态缓存**: 保存电压到 `g_hwpd_dev->volt`
- **委托模式**: 不直接操作硬件，调用 `set_output_voltage` 回调
- **无验证**: 假设 USB Type-C 子系统会处理 PD 协商

#### 4.1.2 获取输出电压

```c
static int hwpd_get_output_voltage(int *volt)
{
    struct hwpd_dev *l_dev = hwpd_get_dev();
    
    if (!l_dev || !volt)
        return -EPERM;
    
    /* 直接返回缓存值 */
    *volt = l_dev->volt;
    return 0;
}
```

**注意事项**:
- **非实时查询**: 返回的是缓存值，不是实际适配器电压
- **同步假设**: 假设 PD 协商成功，实际电压与缓存一致

### 4.2 硬复位

```c
static int hwpd_hard_reset_master(void)
{
    struct hwpd_ops *l_ops = hwpd_get_ops();
    
    if (!l_ops || !l_ops->hard_reset_master) {
        hwlog_err("hard_reset_master is null\n");
        return -EPERM;
    }
    
    /* 调用 USB Type-C 子系统的 Hard Reset 函数 */
    l_ops->hard_reset_master(l_ops->dev_data);
    return 0;
}
```

**Hard Reset 作用**:
- **复位 PD 协商**: 适配器恢复到默认 5V 输出
- **清除状态**: 重置 PD Policy Engine 状态机
- **重新协商**: 触发新一轮 PD 能力协商

### 4.3 注册与初始化

#### 4.3.1 ops 注册

```c
int hwpd_ops_register(struct hwpd_ops *ops)
{
    int dev_id;
    
    if (!g_hwpd_dev || !ops || !ops->chip_name) {
        hwlog_err("g_hwpd_dev or ops or chip_name is null\n");
        return -EPERM;
    }
    
    /* 查找设备 ID */
    dev_id = hwpd_get_device_id(ops->chip_name);
    if (dev_id < 0) {
        hwlog_err("%s ops register fail\n", ops->chip_name);
        return -EPERM;
    }
    
    /* 注册 ops */
    g_hwpd_dev->p_ops = ops;
    g_hwpd_dev->dev_id = dev_id;
    
    hwlog_info("%d:%s ops register ok\n", dev_id, ops->chip_name);
    return 0;
}
```

#### 4.3.2 模块初始化

```c
static int __init hwpd_init(void)
{
    int ret;
    struct hwpd_dev *l_dev;
    
    /* 分配设备结构 */
    l_dev = kzalloc(sizeof(*l_dev), GFP_KERNEL);
    if (!l_dev)
        return -ENOMEM;
    
    g_hwpd_dev = l_dev;
    l_dev->dev_id = PROTOCOL_DEVICE_ID_END;
    
    /* 默认电压 9V */
    l_dev->volt = ADAPTER_9V * POWER_MV_PER_V;  // 9000mV
    
    /* 注册到 adapter_protocol 框架 */
    ret = adapter_protocol_ops_register(&adapter_protocol_hwpd_ops);
    if (ret)
        goto fail_register_ops;
    
    return 0;
    
fail_register_ops:
    kfree(l_dev);
    g_hwpd_dev = NULL;
    return ret;
}
```

**初始化流程**:
1. 分配 `hwpd_dev` 结构体
2. 设置默认电压为 9V
3. 注册 4 个协议接口到 adapter_protocol

---

## 五、与 USB Type-C 子系统集成

### 5.1 USB Type-C 侧实现

```c
/* oem-typec-adapter.c */

#ifdef CONFIG_ADAPTER_PROTOCOL_PD
static struct hwpd_ops hisi_device_pd_protocol_ops = {
    .chip_name = "scharger_v600",
    .hard_reset_master = hisi_usb_typec_issue_hardreset,
    .set_output_voltage = hisi_usb_typec_set_pd_adapter_voltage,
};
#endif

static int oem_typec_register_pd_dpm(void)
{
    int ret;
    void *data = (void *)&_oem_typec;
    
    /* 注册 PD DPM ops */
    ret = pd_dpm_ops_register(&hisi_device_pd_dpm_ops, data);
    if (ret)
        return -EBUSY;
    
#ifdef CONFIG_ADAPTER_PROTOCOL_PD
    /* 注册 PD 协议 ops */
    hisi_device_pd_protocol_ops.dev_data = data;
    ret = hwpd_ops_register(&hisi_device_pd_protocol_ops);
    if (ret) {
        I("pd protocol register failed\n");
        return -EBUSY;
    }
#endif
    
    return 0;
}
```

### 5.2 实际功能实现

**设置 PD 电压**:
```c
/* USB Type-C 子系统实现 */
void hisi_usb_typec_set_pd_adapter_voltage(int volt, void *dev_data)
{
    struct oem_typec *typec = (struct oem_typec *)dev_data;
    
    /* 调用 TCPM API 发起 PD Request */
    // 1. 根据 volt 查找匹配的 PDO
    // 2. 构造 Request Message
    // 3. 发送给 PD 适配器
    // 4. 等待 Accept/Reject
    // 5. 等待电压切换完成
    
    hwlog_info("PD voltage set to %dmV\n", volt);
}
```

**PD Hard Reset**:
```c
void hisi_usb_typec_issue_hardreset(void *dev_data)
{
    struct oem_typec *typec = (struct oem_typec *)dev_data;
    
    /* 调用 TCPM API 发送 Hard Reset */
    // 1. 通知 Policy Engine
    // 2. 发送 Hard Reset 信号
    // 3. 等待复位完成
    // 4. 重新进入协商流程
    
    hwlog_info("PD Hard Reset issued\n");
}
```

---

## 六、典型使用场景

### 场景 1: PD 快充初始化

```c
/* Direct Charge 调用 PD 协议 */
static int dc_init_pd_adapter(void)
{
    int ret, mode;
    
    /* Step 1: 检测 PD 适配器（通过 USB Type-C 子系统） */
    ret = adapter_detect_support_mode(ADAPTER_PROTOCOL_PD, &mode);
    if (ret == ADAPTER_DETECT_SUCC) {
        hwlog_info("PD adapter detected\n");
    }
    
    /* Step 2: 设置 PD 电压到 9V */
    ret = adapter_set_output_voltage(ADAPTER_PROTOCOL_PD, 9000);
    hwlog_info("PD voltage set to 9V\n");
    
    /* Step 3: 验证电压 */
    int volt;
    adapter_get_output_voltage(ADAPTER_PROTOCOL_PD, &volt);
    hwlog_info("Current PD voltage: %dmV\n", volt);
    // 输出: 9000mV (缓存值)
    
    return 0;
}
```

### 场景 2: PD 电压切换

```c
/* 动态调整 PD 电压 */
static void pd_voltage_switch_flow(void)
{
    /* 阶段 1: 协商到 9V */
    adapter_set_output_voltage(ADAPTER_PROTOCOL_PD, 9000);
    msleep(500);  // 等待 PD 协商完成
    
    /* 阶段 2: 切换到 12V (如果 PDO 支持) */
    adapter_set_output_voltage(ADAPTER_PROTOCOL_PD, 12000);
    msleep(500);
    
    /* 阶段 3: 切换到 20V (如果 PDO 支持) */
    adapter_set_output_voltage(ADAPTER_PROTOCOL_PD, 20000);
    msleep(500);
    
    /* 注意: 实际是否成功取决于 PD 适配器的 PDO 能力 */
}
```

### 场景 3: PD Hard Reset

```c
/* 协商失败时执行 Hard Reset */
static int pd_recovery_by_hard_reset(void)
{
    hwlog_info("PD negotiation failed, try hard reset\n");
    
    /* Step 1: 发送 Hard Reset */
    adapter_hard_reset_master(ADAPTER_PROTOCOL_PD);
    
    /* Step 2: 等待复位完成（适配器回到 5V） */
    msleep(1000);
    
    /* Step 3: 重新协商 */
    adapter_set_output_voltage(ADAPTER_PROTOCOL_PD, 9000);
    msleep(500);
    
    /* Step 4: 验证电压 */
    int vbus = get_charger_vbus();
    if (abs(vbus - 9000) < 500) {
        hwlog_info("PD recovery success\n");
        return 0;
    }
    
    hwlog_err("PD recovery failed\n");
    return -EPERM;
}
```

### 场景 4: PD 与 SCP 协同

```c
/* 优先使用 PD，降级到 SCP */
static int select_best_protocol(void)
{
    int mode, ret;
    
    /* 优先检测 PD (标准协议，兼容性好) */
    ret = adapter_detect_support_mode(ADAPTER_PROTOCOL_PD, &mode);
    if (ret == ADAPTER_DETECT_SUCC) {
        hwlog_info("Use PD protocol\n");
        return ADAPTER_PROTOCOL_PD;
    }
    
    /* PD 失败，尝试 SCP (功率更高) */
    ret = adapter_detect_support_mode(ADAPTER_PROTOCOL_SCP, &mode);
    if (ret == ADAPTER_DETECT_SUCC) {
        hwlog_info("Use SCP protocol\n");
        return ADAPTER_PROTOCOL_SCP;
    }
    
    /* 都失败，使用标准充电 */
    hwlog_info("Use standard charging\n");
    return ADAPTER_PROTOCOL_UNKNOWN;
}
```

### 场景 5: QTR 双口适配器处理

```c
/* 检测 QTR (钱塘江) 双口 PD 适配器 */
static bool is_qtr_pd_adapter(void)
{
    int adapter_type;
    
    /* 获取适配器类型 */
    adapter_get_adp_type(ADAPTER_PROTOCOL_PD, &adapter_type);
    
    if (adapter_type == ADAPTER_TYPE_QTR_C_20V3A ||
        adapter_type == ADAPTER_TYPE_QTR_C_10V4A) {
        hwlog_info("QTR dual-port PD adapter detected\n");
        
        /* QTR 适配器需要特殊处理 */
        // 1. 强制启用 VCONN (为 E-Marker 供电)
        // 2. 支持 Type-C 口 60W 输出
        
        return true;
    }
    
    return false;
}
```

---

## 七、调试方法

### 7.1 Kernel 日志分析

#### 关键日志标签
```bash
# 过滤 PD 协议相关日志
adb shell dmesg | grep "pd_protocol"
adb shell dmesg | grep "hwpd"
adb shell dmesg | grep "adapter_protocol"

# USB Type-C PD 日志
adb shell dmesg | grep "oem_typec"
adb shell dmesg | grep "TCPM"
adb shell dmesg | grep "PD_DPM"
```

#### 典型日志输出

**模块初始化**:
```
[    5.200] pd_protocol: 1:scharger_v600 ops register ok
```

**电压设置**:
```
[   15.100] pd_protocol: set output voltage: 9000
[   15.150] oem_typec: PD voltage set to 9000mV
[   15.200] TCPM: Request 9V/3A PDO
[   15.300] TCPM: PD negotiation success, switched to 9V
```

**Hard Reset**:
```
[   20.000] pd_protocol: hard_reset_master
[   20.010] oem_typec: PD Hard Reset issued
[   20.100] TCPM: Hard Reset signal sent
[   20.500] TCPM: Reset to vSafe5V
```

### 7.2 Sysfs 调试接口

```bash
# 查看 PD 状态
cat /sys/class/hw_power/charger/adapter_detect
# Output: protocol=pd type=PD3.0 voltage=9V current=3A

# 查看 USB Type-C 状态
cat /sys/class/typec/port0/power_role
# Output: sink (接收端)

cat /sys/class/typec/port0/data_role
# Output: device

# 查看 PD 协商的 PDO
cat /sys/kernel/debug/tcpm/port0/pdos
# Output:
# PDO 0: 5V 3A
# PDO 1: 9V 3A
# PDO 2: 12V 2.25A
# PDO 3: 15V 2A
# PDO 4: 20V 1.35A
```

### 7.3 常见问题诊断

| **现象** | **可能原因** | **检查方法** | **解决方案** |
|---------|------------|------------|------------|
| 电压设置无效 | PD 协商失败 | 检查 TCPM 日志 | 确认 PDO 支持目标电压 |
| 电压不稳定 | CC 线接触不良 | 检查 Type-C 连接 | 重新插拔线缆 |
| Hard Reset 失败 | TCPM 未响应 | 检查 TCPC 驱动 | 重启 USB Type-C 子系统 |
| 获取电压错误 | 缓存未更新 | 对比实际 VBUS | 读取实际充电器电压 |
| ops 注册失败 | chip_name 不匹配 | 检查设备映射表 | 确认芯片名称正确 |

### 7.4 调试示例

**检查 PD 协商过程**:
```bash
# 使能 TCPM debug
echo 1 > /sys/module/tcpm/parameters/debug

# 触发 PD 协商
echo 9000 > /sys/class/hw_power/charger/adapter_voltage

# 查看详细日志
dmesg -w | grep TCPM
# Output:
# TCPM: Requesting PDO 1: 9V @ 3A
# TCPM: Waiting for PS_RDY
# TCPM: Received PS_RDY
# TCPM: Voltage transition complete
```

---

## 八、性能与设计特点

### 8.1 极简设计优势

**代码对比**:
```
PD:  217 行 (100%)
FCP: 818 行 (377%)
SCP: 2590 行 (1193%)
```

**优势**:
- **维护成本低**: 代码量少，逻辑简单
- **稳定性高**: 委托给成熟的 TCPM 子系统
- **标准兼容**: 遵循 USB-IF PD 规范
- **功能完整**: 满足充电需求的核心功能

### 8.2 委托模式分析

**设计模式**:
```
┌─────────────────────────────────────────┐
│  adapter_protocol_pd.c                  │
│  (Wrapper/Adapter Pattern)              │
│                                         │
│  • 不实现具体功能                         │
│  • 仅提供统一接口                         │
│  • 委托给专业子系统                       │
└─────────────────┬───────────────────────┘
                  │ 委托
┌─────────────────▼───────────────────────┐
│  USB Type-C Subsystem                   │
│  (Real Implementation)                  │
│                                         │
│  • PD Policy Engine                     │
│  • Protocol Layer                       │
│  • TCPC Driver                          │
└─────────────────────────────────────────┘
```

**优势**:
- **职责分离**: PD 协议由专业 TCPM 处理
- **复用性**: 避免重复实现 PD 协议栈
- **标准遵循**: TCPM 严格遵循 USB PD 规范

### 8.3 状态缓存策略

```c
/* 电压缓存机制 */
g_hwpd_dev->volt = volt;  // 立即缓存

/* 假设 */
// 1. PD 协商总是成功
// 2. 缓存值等于实际值
// 3. 不需要实时读取硬件
```

**优点**:
- **响应快**: 获取电压无延迟
- **无硬件访问**: 减少 TCPM 调用

**缺点**:
- **可能不准**: 协商失败时缓存与实际不符
- **无验证**: 不检查实际适配器电压

---

## 九、最佳实践

### 9.1 电压设置

```c
/* 推荐做法 */
static int pd_set_voltage_safe(int target_volt)
{
    int vbus;
    
    /* Step 1: 设置电压 */
    adapter_set_output_voltage(ADAPTER_PROTOCOL_PD, target_volt);
    
    /* Step 2: 等待协商完成 */
    msleep(500);  // PD 协商通常 < 300ms
    
    /* Step 3: 验证实际电压 */
    vbus = get_charger_vbus();  // 读取实际 VBUS
    if (abs(vbus - target_volt) > 500) {
        hwlog_err("PD voltage mismatch: target=%d, actual=%d\n",
            target_volt, vbus);
        return -EPERM;
    }
    
    return 0;
}
```

### 9.2 错误恢复

```c
/* Hard Reset 恢复策略 */
static int pd_recovery_strategy(void)
{
    int retry;
    
    for (retry = 0; retry < 3; retry++) {
        /* 尝试 Hard Reset */
        adapter_hard_reset_master(ADAPTER_PROTOCOL_PD);
        msleep(1000);
        
        /* 重新协商 */
        if (pd_set_voltage_safe(9000) == 0) {
            hwlog_info("PD recovery success at retry %d\n", retry);
            return 0;
        }
    }
    
    hwlog_err("PD recovery failed after 3 retries\n");
    return -EPERM;
}
```

### 9.3 与其他协议协同

```c
/* 智能协议选择 */
static int select_optimal_protocol(void)
{
    int pd_power, scp_power;
    
    /* 获取 PD 功率能力 */
    if (adapter_detect_support_mode(ADAPTER_PROTOCOL_PD, &mode) == 0) {
        pd_power = get_pd_max_power();  // 读取 PDO
        
        /* 获取 SCP 功率能力 */
        if (adapter_detect_support_mode(ADAPTER_PROTOCOL_SCP, &mode) == 0) {
            scp_power = get_scp_max_power();
            
            /* 选择功率更高的协议 */
            if (scp_power > pd_power) {
                hwlog_info("Choose SCP: %dW > PD: %dW\n",
                    scp_power/1000, pd_power/1000);
                return ADAPTER_PROTOCOL_SCP;
            }
        }
        
        return ADAPTER_PROTOCOL_PD;
    }
    
    return ADAPTER_PROTOCOL_UNKNOWN;
}
```

---

## 十、总结

### 10.1 核心特性总结

| **特性** | **描述** | **技术亮点** |
|---------|---------|------------|
| **代码规模** | 217 行 | 所有协议中最精简 |
| **设计模式** | 委托模式 | 转发给 USB Type-C 子系统 |
| **协议标准** | USB PD 3.0/2.0 | 遵循 USB-IF 规范 |
| **功率范围** | 15W~240W | 取决于 PD 适配器 PDO |
| **接口数量** | 4 个 | 仅核心功能 |
| **硬件依赖** | TCPM 子系统 | 无直接寄存器操作 |
| **芯片支持** | 4 种 | TCPC 控制器 |
| **状态管理** | 电压缓存 | 快速查询 |

### 10.2 优势分析

**相比私有协议 (SCP/FCP)**:
- **标准化**: USB-IF 标准，兼容性好
- **简洁性**: 代码量仅 8% (217/2590)
- **稳定性**: 依赖成熟的 TCPM 子系统
- **维护性**: 极少的代码，易于维护

**相比完整 PD 实现**:
- **复用性**: 避免重复实现 PD 协议栈
- **专业性**: TCPM 是 USB 官方参考实现
- **功能性**: 满足充电场景的核心需求

### 10.3 设计理念

```
"Do One Thing Well"

adapter_protocol_pd 的核心设计理念：
1. 不重复造轮子 → 委托给 TCPM
2. 提供统一接口 → 适配充电框架
3. 保持极简设计 → 仅包装核心功能
4. 遵循标准协议 → USB PD 规范
```

### 10.4 适用场景

**推荐使用 PD**:
- USB Type-C 接口设备
- 标准 PD 充电器
- 需要 USB 认证的产品
- 多协议兼容场景

**推荐使用 SCP**:
- 华为私有快充适配器
- 需要超高功率 (>100W)
- 需要精确电压控制
- 华为生态设备

**推荐使用 FCP**:
- 老旧华为快充适配器
- 简单快充需求 (18W~36W)
- Micro-USB 接口设备

### 10.5 技术创新点

- **极简包装**: 仅 217 行实现 PD 协议适配
- **委托模式**: 充分利用现有 TCPM 子系统
- **零硬件操作**: 通过 Type-C 框架间接控制
- **状态缓存**: 电压值缓存提升查询性能
- **标准遵循**: 严格遵循 USB PD 规范
