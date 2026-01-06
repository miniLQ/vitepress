
# Unstructured VDM 私有充电协议

## 1. 模块定位与核心价值

`adapter_protocol_uvdm` 是华为充电框架中基于 **USB PD UVDM (Unstructured VDM - Vendor Defined Message)** 的私有充电协议实现。该模块利用 USB Type-C 的厂商自定义消息机制，在 PD 协议框架内传输华为私有充电控制指令。

### 核心特性

- **基于 USB PD VDM 标准扩展**：利用 USB PD 规范中的 Vendor Defined Message 机制
- **华为 VID (0x12d1)**：使用华为厂商 ID，确保消息只在华为设备间识别
- **多功能域支持**：DC 控制、PD 控制、USB 扩展 Modem 等
- **双向通信**：支持适配器上报功率类型、异常事件、OTG 事件等
- **Hash 认证**：与 SCP/UFCS 类似的随机数+哈希认证机制
- **功率模式切换**：支持 Buck↔Super Charge 模式切换

### 与其他协议对比

| 特性 | UVDM | PD | SCP | UFCS |
|------|------|----|----|------|
| 传输层 | USB PD VDM | USB TCPM | I2C/D+D- | I2C/UART |
| 标准化程度 | 华为私有 | USB-IF 标准 | 华为私有 | CCSA 标准 |
| 代码复杂度 | 低（652行） | 极低（217行） | 高（2590行） | 极高（3500+行） |
| 认证方式 | Hash (Power Genl) | 无 | Hash (Power Genl) | Hash (Power Genl) |
| 应用场景 | Type-C 有线快充 | 通用 PD 充电 | D+/D- 快充 | 跨品牌快充 |

---

## 2. 系统架构

### 2.1 分层架构图

```
┌─────────────────────────────────────────────────────────────┐
│                  应用层 (Direct Charge)                      │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│           adapter_protocol.c (协议路由层)                    │
│  - adapter_protocol_ops_register()                           │
│  - adapter_set_output_voltage()                              │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│       adapter_protocol_uvdm.c (UVDM 协议控制层)             │
│  ┌──────────────────┬─────────────────┬──────────────────┐  │
│  │ 电压控制         │ 认证管理        │ 功率模式切换      │  │
│  │ set/get_voltage  │ auth_encrypt    │ set_power_mode   │  │
│  └──────────────────┴─────────────────┴──────────────────┘  │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ UVDM 消息封装 (VDO Header + Data Objects)            │   │
│  │ - hwuvdm_package_header_data()                        │   │
│  │ - hwuvdm_send_data()                                  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ UVDM 消息解析 (Notifier 回调)                         │   │
│  │ - hwuvdm_handle_receive_dc_ctrl_data()                │   │
│  │ - hwuvdm_handle_receive_pd_ctrl_data()                │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│      adapter_protocol_uvdm_auth.c (认证服务)                │
│  - Power Genl 通信 (POWER_GENL_CMD_UVDM_AUTH_HASH)          │
│  - hwuvdm_auth_wait_completion()                             │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│           hwuvdm_ops (硬件抽象层)                            │
│  - send_data()                                               │
│  - chip_name: "scharger_v600"                                │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│          USB Type-C PD PHY (scharger_v600)                   │
│  - USB PD VDM 消息发送/接收                                  │
│  - 通知链事件: POWER_NE_UVDM_RECEIVE                        │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 关键数据流

#### 发送流程 (主机 → 适配器)
```
应用调用 adapter_set_output_voltage(9000)
    ↓
hwuvdm_set_output_voltage()
    ↓
hwuvdm_package_header_data(HWUVDM_CMD_SET_VOLTAGE)
    ↓
构造 VDO[0]=Header, VDO[1]=900 (9000mV/10)
    ↓
hwuvdm_send_data(vdo, 2, false)
    ↓
hwuvdm_ops->send_data()
    ↓
USB PD PHY 通过 Type-C CC 线发送 VDM 消息
```

#### 接收流程 (适配器 → 主机)
```
USB PD PHY 接收到 VDM 消息
    ↓
触发 power_event_bnc_notify(POWER_BNT_UVDM, POWER_NE_UVDM_RECEIVE)
    ↓
hwuvdm_notifier_call()
    ↓
hwuvdm_handle_receive_data()
    ↓
检查 VID=0x12d1, VDM_TYPE=0 (UVDM)
    ↓
根据 Function 分发:
    - HWUVDM_FUNCTION_DC_CTRL → hwuvdm_handle_receive_dc_ctrl_data()
    - HWUVDM_FUNCTION_PD_CTRL → hwuvdm_handle_receive_pd_ctrl_data()
    ↓
根据 CMD 执行具体操作:
    - CMD_REPORT_POWER_TYPE → 完成 report_type_comp
    - CMD_GET_VOLTAGE → 解析电压值并完成 rsp_comp
    - CMD_REPORT_ABNORMAL → 发送异常事件通知
```

---

## 3. 核心数据结构

### 3.1 UVDM Header 消息格式

```c
/*
 * UVDM 消息头（32 bit）位域分布：
 *
 * bit 31~16: VID (Vendor ID)            = 0x12d1 (华为)
 * bit 15:    VDM Type                    = 0 (Unstructured)
 * bit 14~13: UVDM Version                = 0
 * bit 12~8:  Function (功能域)           = 3 (DC_CTRL)
 * bit 7~1:   Command (具体命令)          = 6 (SET_VOLTAGE)
 * bit 0:     Command Direction           = 0 (Initial) / 1 (Answer)
 */
enum hwuvdm_header_data_shift {
    HWUVDM_HDR_SHIFT_CMD_DIRECTTION = 0,
    HWUVDM_HDR_SHIFT_CMD = 1,
    HWUVDM_HDR_SHIFT_FUNCTION = 8,
    HWUVDM_HDR_SHIFT_VERSION = 13,
    HWUVDM_HDR_SHIFT_VDM_TYPE = 15,
    HWUVDM_HDR_SHIFT_VID = 16,
};
```

**示例**：设置电压 9V 的 VDM 消息
```c
VDO[0] = 0x12D18306  // Header
  = (0x12d1 << 16)   // VID = 华为
  | (0 << 15)        // VDM Type = UVDM
  | (0 << 13)        // Version = 0
  | (3 << 8)         // Function = DC_CTRL
  | (6 << 1)         // Command = SET_VOLTAGE
  | (0 << 0)         // Direction = Initial

VDO[1] = 900         // 电压值 = 9000mV / 10
```

### 3.2 核心结构体

```c
/* UVDM 硬件操作接口 */
struct hwuvdm_ops {
    const char *chip_name;        // 芯片名称: "scharger_v600"
    void *dev_data;               // 私有数据
    void (*send_data)(u32 *data, u8 cnt, bool wait_rsp, void *dev_data);
};

/* UVDM 设备控制结构 */
struct hwuvdm_dev {
    struct device *dev;
    struct notifier_block nb;              // 接收 VDM 消息的通知链
    struct completion rsp_comp;            // 等待响应完成量
    struct completion report_type_comp;    // 等待功率类型上报
    int dev_id;                            // 设备 ID
    struct hwuvdm_ops *p_ops;              // 硬件操作接口
    u8 encrypt_random_value[8];            // 随机数（用于认证）
    u8 encrypt_hash_value[8];              // 哈希值（适配器返回）
    struct hwuvdm_device_info info;        // 设备信息
};

/* 设备信息 */
struct hwuvdm_device_info {
    int power_type;        // 功率类型
    int volt;              // 当前电压
    int abnormal_flag;     // 异常标志
    int otg_event;         // OTG 事件
};
```

---

## 4. 核心功能实现

### 4.1 电压设置流程

```c
static int hwuvdm_set_output_voltage(int volt)
{
    u32 data[HWUVDM_VDOS_COUNT_TWO] = { 0 };

    /* data[0]: header */
    data[0] = hwuvdm_package_header_data(HWUVDM_CMD_SET_VOLTAGE);
    /* data[1]: voltage, 单位 10mV */
    data[1] = volt / HWUVDM_VOLTAGE_UNIT;

    // false: 不等待响应（适配器会自动执行）
    return hwuvdm_handle_vdo_data(data, HWUVDM_VDOS_COUNT_TWO, false, 0);
}
```

**特点**：
- 电压单位为 10mV（如 9000mV 发送时为 900）
- 不等待响应，提高效率
- 通过 VDM 直接控制适配器输出

### 4.2 电压查询流程

```c
static int hwuvdm_get_output_voltage(int *volt)
{
    u32 data[HWUVDM_VDOS_COUNT_ONE] = { 0 };
    int ret;
    struct hwuvdm_dev *l_dev = hwuvdm_get_dev();

    if (!l_dev || !volt)
        return -EPERM;

    /* data[0]: header */
    data[0] = hwuvdm_package_header_data(HWUVDM_CMD_GET_VOLTAGE);

    // 发送查询命令，等待响应，最多重试 3 次
    ret = hwuvdm_handle_vdo_data(data, HWUVDM_VDOS_COUNT_ONE, true,
        HWUVDM_RETRY_TIMES);
    if (ret)
        return -EPERM;

    // 从设备结构体中获取解析后的电压值
    *volt = l_dev->info.volt;
    return 0;
}
```

**接收处理**：
```c
static void hwuvdm_get_voltage(u32 data)
{
    struct hwuvdm_dev *l_dev = hwuvdm_get_dev();

    if (!l_dev)
        return;

    // 解析电压值（单位转换回 mV）
    l_dev->info.volt = (data & HWUVDM_MASK_VOLTAGE) * HWUVDM_VOLTAGE_UNIT;
    
    // 唤醒等待线程
    complete(&l_dev->rsp_comp);
}
```

### 4.3 Hash 认证流程

```c
static int hwuvdm_auth_encrypt_start(int key)
{
    struct hwuvdm_dev *l_dev = hwuvdm_get_dev();
    int ret;

    if (!l_dev)
        return -EPERM;

    /* 第一步：设置密钥索引 */
    if (hwuvdm_set_encrypt_index(l_dev->encrypt_random_value, key))
        return -EPERM;

    /* 第二步：主机生成随机数（7 字节） */
    if (hwuvdm_set_random_num(l_dev->encrypt_random_value,
        HWUVDM_RANDOM_S_OFFSET, HWUVDM_RANDOM_E_OFFESET))
        return -EPERM;

    /* 第三步：主机发送随机数到从机 */
    if (hwuvdm_send_random_num(l_dev->encrypt_random_value))
        return -EPERM;

    /* 第四步：主机从从机获取哈希值 */
    if (hwuvdm_get_encrypted_value())
        return -EPERM;

    /* 第五步：复制哈希值到认证模块 */
    hwuvdm_auth_clean_hash_data();
    if (hwuvdm_copy_hash_value(hwuvdm_auth_get_hash_data_header(),
        hwuvdm_auth_get_hash_data_size()))
        return -EPERM;

    /* 第六步：等待 Power Genl 服务计算哈希并返回结果 */
    ret = hwuvdm_auth_wait_completion();
    hwuvdm_auth_clean_hash_data();

    hwlog_info("auth_encrypt_start\n");
    return ret;
}
```

**认证数据组成**：
```
Hash Input Data (16 bytes):
[0]:    密钥索引
[1-7]:  随机数（主机生成）
[8-15]: 哈希值（适配器返回）
```

**认证服务实现**（adapter_protocol_uvdm_auth.c）：
```c
int hwuvdm_auth_wait_completion(void)
{
    g_hwuvdm_auth_result = 0;
    reinit_completion(&g_hwuvdm_auth_completion);

    // 检查认证服务是否就绪
    if (g_hwuvdm_auth_srv_state == false) {
        hwlog_err("service not ready\n");
        return -EPERM;
    }

    // 通过 Power Genl 发送哈希数据到用户态认证服务
    power_genl_easy_send(POWER_GENL_TP_AF,
        POWER_GENL_CMD_UVDM_AUTH_HASH, 0,
        g_hwuvdm_auth_hash, HWUVDM_AUTH_HASH_LEN);

    // 等待用户态服务返回结果（超时 1000ms）
    if (!wait_for_completion_timeout(&g_hwuvdm_auth_completion,
        msecs_to_jiffies(HWUVDM_AUTH_WAIT_TIMEOUT))) {
        hwlog_err("service wait timeout\n");
        return -EPERM;
    }

    // 检查哈希计算结果
    if (g_hwuvdm_auth_result == 0) {
        hwlog_err("hash calculate fail\n");
        return -EPERM;
    }

    hwlog_info("hash calculate ok\n");
    return 0;
}

// Power Genl 回调（接收用户态认证结果）
static int hwuvdm_auth_cb(unsigned char version, void *data, int len)
{
    if (!data || (len != 1)) {
        hwlog_err("data is null or len invalid\n");
        return -EPERM;
    }

    g_hwuvdm_auth_result = *(int *)data;
    complete(&g_hwuvdm_auth_completion);

    hwlog_info("version=%u auth_result=%d\n", version, g_hwuvdm_auth_result);
    return 0;
}
```

### 4.4 功率模式切换

```c
static int hwuvdm_set_slave_power_mode(int mode)
{
    u32 data[HWUVDM_VDOS_COUNT_TWO] = { 0 };

    /* data[0]: header */
    data[0] = hwuvdm_package_header_data(HWUVDM_CMD_SWITCH_POWER_MODE);
    /* data[1]: power mode */
    data[1] = mode;

    // Buck → SC 需要等待响应（适配器准备就绪）
    if (mode == HWUVDM_PWR_MODE_BUCK2SC)
        return hwuvdm_handle_vdo_data(data, HWUVDM_VDOS_COUNT_TWO,
            true, HWUVDM_RETRY_TIMES);
    else
        // SC → Buck 不需要等待
        return hwuvdm_handle_vdo_data(data, HWUVDM_VDOS_COUNT_TWO,
            false, 0);
}
```

**支持的模式**：
```c
enum hwuvdm_power_mode {
    HWUVDM_PWR_MODE_DEFAULT,      // 默认模式
    HWUVDM_PWR_MODE_BUCK2SC,      // Buck → Super Charge
    HWUVDM_PWR_MODE_SC2BUCK5W,    // SC → Buck 5W
    HWUVDM_PWR_MODE_SC2BUCK10W,   // SC → Buck 10W
};
```

### 4.5 消息接收与解析

```c
static int hwuvdm_notifier_call(struct notifier_block *nb,
    unsigned long event, void *data)
{
    struct hwuvdm_dev *l_dev = hwuvdm_get_dev();

    if (!l_dev)
        return NOTIFY_OK;

    switch (event) {
    case POWER_NE_UVDM_RECEIVE:
        hwuvdm_handle_receive_data(data);
        return NOTIFY_OK;
    default:
        return NOTIFY_OK;
    }
}

static int hwuvdm_handle_receive_data(void *data)
{
    u32 vdo[HWUVDM_VDOS_COUNT_SEVEN] = { 0 };
    u32 vdo_hdr;
    u32 func;
    int ret;

    if (!data)
        return -EPERM;

    memcpy(vdo, data, sizeof(vdo));
    vdo_hdr = vdo[0];
    
    // 检查 VID 和 VDM Type 是否匹配
    ret = hwuvdm_check_receive_data(vdo_hdr);
    if (ret)
        return -EPERM;

    // 根据功能域分发消息
    func = (vdo_hdr >> HWUVDM_HDR_SHIFT_FUNCTION) & HWUVDM_MASK_FUNCTION;
    switch (func) {
    case HWUVDM_FUNCTION_DC_CTRL:
        hwuvdm_handle_receive_dc_ctrl_data(vdo, HWUVDM_VDOS_COUNT_THREE);
        break;
    case HWUVDM_FUNCTION_PD_CTRL:
        hwuvdm_handle_receive_pd_ctrl_data(vdo, HWUVDM_VDOS_COUNT_THREE);
        break;
    case HWUVDM_FUNCTION_USB_EXT_MODEM:
        // 转发到 USB 扩展 Modem 模块
        power_event_bnc_notify(POWER_BNT_USB_EXT_MODEM,
            POWER_NE_UEM_RECEIVE_UVDM_DATA, vdo);
        break;
    default:
        break;
    }

    return 0;
}
```

**DC 控制功能域处理**：
```c
static void hwuvdm_handle_receive_dc_crtl_data(u32 *vdo, int len)
{
    u32 cmd;
    u32 vdo_hdr;
    u32 vdo_data0;

    vdo_hdr = vdo[0];   // Header
    vdo_data0 = vdo[1]; // 第一个数据对象

    cmd = (vdo_hdr >> HWUVDM_HDR_SHIFT_CMD) & HWUVDM_MASK_CMD;
    switch (cmd) {
    case HWUVDM_CMD_REPORT_POWER_TYPE:
        hwuvdm_report_power_type(vdo_data0);
        break;
    case HWUVDM_CMD_REPORT_ABNORMAL:
        hwuvdm_report_abnormal_event(vdo_data0);
        break;
    case HWUVDM_CMD_SEND_RANDOM:
        hwuvdm_send_random(vdo_data0);
        break;
    case HWUVDM_CMD_SWITCH_POWER_MODE:
        hwuvdm_switch_power_mode(vdo_data0);
        break;
    case HWUVDM_CMD_GET_VOLTAGE:
        hwuvdm_get_voltage(vdo_data0);
        break;
    case HWUVDM_CMD_GET_HASH:
        hwuvdm_get_hash(vdo, HWUVDM_VDOS_COUNT_THREE);
        break;
    default:
        break;
    }
}
```

---

## 5. 命令集详解

### 5.1 DC 控制命令（HWUVDM_FUNCTION_DC_CTRL）

| 命令 ID | 命令名称 | 方向 | 功能 | VDO 数量 |
|---------|---------|------|------|----------|
| 1 | REPORT_POWER_TYPE | Adapter→Host | 上报功率类型 | 2 |
| 2 | SEND_RANDOM | Host↔Adapter | 发送认证随机数 | 3 |
| 3 | GET_HASH | Host→Adapter | 获取哈希值 | 1→3 |
| 4 | SWITCH_POWER_MODE | Host→Adapter | 切换功率模式 | 2 |
| 5 | SET_ADAPTER_ENABLE | Host→Adapter | 使能适配器 | 2 |
| 6 | SET_VOLTAGE | Host→Adapter | 设置输出电压 | 2 |
| 7 | GET_VOLTAGE | Host→Adapter | 查询输出电压 | 1→2 |
| 8 | GET_TEMP | Host→Adapter | 查询温度 | 1→2 |
| 9 | HARD_RESET | Host→Adapter | 硬复位 | 1 |
| 10 | REPORT_ABNORMAL | Adapter→Host | 上报异常事件 | 2 |
| 11 | SET_RX_REDUCE_VOLTAGE | Host→Adapter | 降低接收端电压 | 1 |

### 5.2 PD 控制命令（HWUVDM_FUNCTION_PD_CTRL）

| 命令 ID | 命令名称 | 方向 | 功能 | VDO 数量 |
|---------|---------|------|------|----------|
| 1 | REPORT_OTG_EVENT | Adapter→Host | 上报 OTG 事件 | 2 |

### 5.3 其他功能域

- **HWUVDM_FUNCTION_USB_EXT_MODEM**：USB 扩展 Modem（转发到专门模块处理）
- **HWUVDM_FUNCTION_TA_CTRL**：TA 控制（未实现）
- **HWUVDM_FUNCTION_DOCK_CTRL**：Dock 控制（未实现）
- **HWUVDM_FUNCTION_RX_CTRL**：RX 控制（未实现）

---

## 6. 典型应用场景

### 6.1 直充场景（Direct Charge）

```c
/* 场景：40W SuperCharge 直充 */

// Step 1: 适配器上报功率类型
Adapter: VDO[0]=REPORT_POWER_TYPE Header, VDO[1]=POWER_TYPE_40W
Host:    hwuvdm_report_power_type() → complete(report_type_comp)

// Step 2: 主机执行认证
Host:    hwuvdm_auth_encrypt_start(key_index)
         ↓ 生成随机数
         ↓ SEND_RANDOM → Adapter
Adapter: 计算 Hash
         ↓ GET_HASH ← Host
Adapter: 返回 Hash 值
Host:    ↓ Power Genl 验证
         ↓ 认证通过

// Step 3: 切换到 Super Charge 模式
Host:    SWITCH_POWER_MODE(HWUVDM_PWR_MODE_BUCK2SC)
Adapter: 切换电路拓扑
         ↓ 返回 HWUVDM_RESPONSE_POWER_READY
Host:    hwuvdm_switch_power_mode() → complete(rsp_comp)

// Step 4: 设置输出电压
Host:    SET_VOLTAGE(9000)  // 设置 9V
Adapter: 调整输出电压到 9V

// Step 5: 充电过程中查询电压
Host:    GET_VOLTAGE
Adapter: 返回当前电压值
Host:    hwuvdm_get_voltage() → 解析并返回
```

### 6.2 充电完成场景

```c
// 充电完成后降低接收端电压（减少发热）
Host:    SET_RX_REDUCE_VOLTAGE
Adapter: 降低输出电压到最小值
```

### 6.3 异常处理场景

```c
// 适配器检测到过温
Adapter: REPORT_ABNORMAL(abnormal_flag=OVER_TEMP)
Host:    hwuvdm_report_abnormal_event()
         ↓ power_event_anc_notify(POWER_ANT_UVDM_FAULT, 
                                   POWER_NE_UVDM_FAULT_COVER_ABNORMAL)
         ↓ 充电框架降低充电电流或停止充电
```

### 6.4 OTG 反向充电场景

```c
// 进入 OTG 模式
Adapter: REPORT_OTG_EVENT(otg_event=OTG_INSERT)
Host:    hwuvdm_report_otg_event()
         ↓ power_event_anc_notify(POWER_ANT_UVDM_FAULT,
                                   POWER_NE_UVDM_FAULT_OTG)
         ↓ 系统切换到 OTG 模式
```

---

## 7. 硬件抽象层

### 7.1 hwuvdm_ops 注册

```c
/* 示例：scharger_v600 芯片注册 UVDM 操作接口 */
struct hwuvdm_ops scharger_v600_uvdm_ops = {
    .chip_name = "scharger_v600",
    .dev_data = &scharger_v600_dev,
    .send_data = scharger_v600_send_uvdm,
};

// 在驱动初始化时注册
hwuvdm_ops_register(&scharger_v600_uvdm_ops);
```

### 7.2 send_data 实现示例

```c
static void scharger_v600_send_uvdm(u32 *data, u8 cnt, bool wait_rsp, void *dev_data)
{
    struct scharger_v600_device *dev = dev_data;
    struct pd_dpm_vdm_data vdm;

    // 构造 PD DPM VDM 数据结构
    vdm.wait_for_resp = wait_rsp;
    vdm.vdos_nr = cnt;
    memcpy(vdm.vdos, data, cnt * sizeof(u32));

    // 通过 USB PD 子系统发送 VDM
    pd_dpm_send_vdm(dev->port, &vdm);
}
```

---

## 8. 调试方法

### 8.1 日志追踪

```bash
# 使能 UVDM 协议日志
echo 8 > /proc/sys/kernel/printk

# 过滤 UVDM 相关日志
dmesg | grep "uvdm_protocol"

# 关键日志点
[ xxx ] uvdm_protocol: data[0] = 12d18306  # Header
[ xxx ] uvdm_protocol: data[1] = 384       # VDO1（例如电压 900 = 9V）
[ xxx ] uvdm_protocol: uvdm_header: 0x12d18706
[ xxx ] uvdm_protocol: switch power mode data = 4
[ xxx ] uvdm_protocol: auth_encrypt_start
[ xxx ] uvdm_protocol: hash calculate ok
```

### 8.2 sysfs 调试接口

```bash
# 查看协议注册状态
cat /sys/class/hw_power/adapter/adapter_protocol

# 查看适配器类型
cat /sys/class/hw_power/adapter/adapter_type

# 手动设置电压（需要协议支持）
echo 9000 > /sys/class/hw_power/charger/ibus
```

### 8.3 抓取 USB PD 消息

使用 USB PD 分析仪（如 Total Phase Beagle 480）：

```
Time    | SOP | Message Type | VDO[0]     | VDO[1] | Description
--------|-----|--------------|------------|--------|------------------
0.000ms | SOP | VDM          | 0x12D18306 | 0x384  | UVDM: SET_VOLTAGE 9V
5.234ms | SOP | VDM          | 0x12D18307 | 0x384  | UVDM: GET_VOLTAGE Response
```

### 8.4 常见问题诊断

| 问题现象 | 可能原因 | 解决方法 |
|---------|---------|---------|
| 设置电压无响应 | 硬件 ops 未注册 | 检查 `hwuvdm_ops_register()` 调用 |
| 认证失败 | Power Genl 服务未启动 | 检查 `g_hwuvdm_auth_srv_state` |
| 超时错误 | USB PD PHY 通信异常 | 检查 Type-C 连接状态 |
| VID 不匹配 | 适配器非华为品牌 | 确认适配器 VID=0x12d1 |

---

## 9. 与其他协议的关系

### 9.1 协议选择优先级（推测）

```
USB PD 检测
    ↓
检测 UVDM (VID=0x12d1)
    ↓ 成功
使用 UVDM 协议
    ↓ 失败
检测 UFCS (I2C Address=0x42)
    ↓ 失败
检测 SCP (D+/D- 握手)
    ↓ 失败
检测 FCP
    ↓ 失败
使用标准 PD 协议
```

### 9.2 协议共存策略

- **UVDM + PD**：UVDM 在 PD 协议之上工作，可同时使用
- **UVDM vs SCP**：UVDM 用于 Type-C 接口，SCP 用于 Micro USB/Type-A
- **UVDM vs UFCS**：UVDM 是华为私有，UFCS 是跨品牌标准
- **认证机制复用**：UVDM/SCP/UFCS 都使用相同的 Power Genl 认证框架

---

## 10. 总结与对比

### 10.1 UVDM 协议特点

**优势**：
- ✅ 基于 USB PD 标准，硬件兼容性好
- ✅ 代码简洁（652 行），维护成本低
- ✅ 利用 Type-C CC 线通信，无需额外硬件
- ✅ 支持双向通信，适配器可主动上报事件
- ✅ 复用华为认证框架，安全性有保障

**局限性**：
- ❌ 依赖 USB PD PHY 硬件（scharger_v600 等）
- ❌ 仅限华为设备识别（VID=0x12d1）
- ❌ 不如 SCP/UFCS 功能丰富（无功率曲线等高级特性）
- ❌ VDM 消息长度限制（最多 7 个 VDO）

### 10.2 四协议综合对比表

| 维度 | UVDM | PD | SCP | UFCS |
|------|------|----|----|------|
| **传输层** | USB PD VDM | USB TCPM | I2C/D+D- | I2C/UART |
| **代码行数** | 652 | 217 | 2590 | 3500+ |
| **认证** | Hash (Power Genl) | 无 | Hash (Power Genl) | Hash (Power Genl) |
| **电压控制** | 连续（10mV 精度） | PDO 协商 | 连续（1mV 精度） | 连续（10mV 精度） |
| **功率范围** | 15W-100W+ | 15W-240W | 25W-135W | 15W-240W+ |
| **双向通信** | ✅ | ✅ | ✅ | ✅ |
| **跨品牌支持** | ❌ (华为 VID) | ✅ | ❌ | ✅ |
| **硬件依赖** | Type-C PD PHY | Type-C TCPM | SCP 芯片 | UFCS 芯片 |
| **应用场景** | Type-C 快充 | 通用充电 | D+/D- 快充 | 跨品牌快充 |

### 10.3 技术演进思考

```
FCP (2015)
  ↓ 更高功率
SCP (2017)
  ↓ 标准化接口
UVDM (2020)  ← 基于 USB PD 扩展
  ↓ 跨品牌兼容
UFCS (2021)  ← 国标统一
```

UVDM 是华为在 Type-C 时代对私有快充协议的延续，通过复用 USB PD 基础设施降低了硬件成本，但最终充电行业会向 UFCS 等统一标准演进。

---

## 11. 参考资料

- USB Power Delivery Specification v3.1
- 华为 MATE X5 内核源码
- adapter_protocol_uvdm.c
- adapter_protocol_uvdm_auth.c
- adapter_protocol_uvdm.h
