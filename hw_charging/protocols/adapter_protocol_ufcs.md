---
outline: deep
---

# UFCS 融合快充

## 一、模块定位与核心价值

### 1.1 模块概述

**adapter_protocol_ufcs** 是华为 MATE X5 快充系统中的 **UFCS (Universal Fast Charging Specification，融合快充协议) 实现模块**，作为 adapter_protocol 抽象层的协议实现之一，负责实现中国通信标准化协会 (CCSA) 发布的统一快充标准协议，实现跨品牌快充互联互通。

### 1.2 核心功能
- **UFCS 标准协议**: 实现 CCSA《融合快速充电测试方法》标准
- **完整消息系统**: 支持控制消息、数据消息、厂商自定义消息
- **功率协商**: 动态功率曲线查询和请求（最高支持 240W+）
- **双向通信**: 支持主机-适配器、主机-线缆电子标签通信
- **认证机制**: 基于 Hash 的加密认证，防伪验证
- **事件驱动**: 支持适配器主动消息（Ping、Power Change等）
- **测试模式**: 支持标准测试请求，满足认证测试需求

### 1.3 模块特点
- **模块化架构**: 8 个源文件，职责清晰分离
- **完整协议栈**: 从底层消息封装到上层接口的完整实现
- **5 种芯片支持**: STM32G031、CPS2021/2023、SC8546、HISI_UFCS
- **多层次缓存**: 输出能力、设备信息、源信息缓存机制
- **灵活扩展**: 支持厂商自定义 VDM (Vendor Defined Message)

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
│         [根据 ADAPTER_PROTOCOL_UFCS 分发]                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┬───────────────┐
         │             │             │               │
    ┌────▼───┐   ┌────▼───┐   ┌────▼───┐     ┌────▼───┐
    │  UFCS  │   │   SCP  │   │  PD    │ ... │  FCP   │
    └────┬───┘   └────────┘   └────────┘     └────────┘
         │
┌────────▼──────────────────────────────────────────────────┐
│  adapter_protocol_ufcs.c (主控制层)                        │
│  ┌──────────────────────────────────────────────────┐     │
│  │ • 47 个适配器协议接口实现                           │     │
│  │ • 命令重试机制                                      │     │
│  │ • 状态管理与缓存                                    │     │
│  └──────────────────────────────────────────────────┘     │
└────────┬──────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────────────────────────────────┐
│  adapter_protocol_ufcs_base.c (消息处理层)                 │
│  ┌──────────────────────────────────────────────────┐     │
│  │ • 消息封包/解包 (Header + Data)                    │     │
│  │ • 控制消息发送/接收                                 │     │
│  │ • 数据消息发送/接收                                 │     │
│  │ • VDM 消息处理                                     │     │
│  │ • 消息序号管理                                      │     │
│  │ • CRC 校验                                         │     │
│  └──────────────────────────────────────────────────┘     │
└────────┬──────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────────────────────────────────┐
│  adapter_protocol_ufcs_handle.c (事件处理层)               │
│  ┌──────────────────────────────────────────────────┐     │
│  │ • Ping 处理                                        │     │
│  │ • Soft Reset 处理                                  │     │
│  │ • Get Sink/Device Info 响应                       │     │
│  │ • Cable Detect 处理                                │     │
│  │ • Test Request 处理                                │     │
│  │ • Power Change 事件                                │     │
│  └──────────────────────────────────────────────────┘     │
└────────┬──────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────────────────────────────────┐
│  adapter_protocol_ufcs_interface.c (硬件抽象层)            │
│  ┌──────────────────────────────────────────────────┐     │
│  │ • detect_adapter() - 适配器检测                    │     │
│  │ • write_msg() - 消息发送                           │     │
│  │ • read_msg() - 消息接收                            │     │
│  │ • wait_msg_ready() - 等待消息就绪                  │     │
│  │ • soft_reset_master() - 主机复位                   │     │
│  │ • hard_reset_cable() - 线缆复位                    │     │
│  │ • config_baud_rate() - 波特率配置                  │     │
│  └──────────────────────────────────────────────────┘     │
└────────┬──────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────────────────────────────────┐
│  adapter_protocol_ufcs_auth.c (认证子模块)                 │
│  ┌──────────────────────────────────────────────────┐     │
│  │ • Power Genl 通信 (与用户态防伪服务)                │     │
│  │ • Hash 数据缓存                                     │     │
│  │ • Completion 同步机制                               │     │
│  └──────────────────────────────────────────────────┘     │
└────────┬──────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────────────────────────────────┐
│  Hardware Layer (hwufcs_ops)                              │
│  [5 种芯片平台的底层实现]                                   │
│  • STM32G031  • CPS2021  • CPS2023                        │
│  • SC8546     • HISI_UFCS                                 │
└───────────────────────────────────────────────────────────┘
         │
         ▼
    UFCS Adapter (融合快充适配器)
```

### 2.2 文件职责划分

| **文件** | **职责** | **行数** | **核心功能** |
|---------|---------|---------|------------|
| adapter_protocol_ufcs.c | 主控制层 | ~1251 | 47 个接口实现、命令重试、状态管理 |
| adapter_protocol_ufcs_base.c | 消息层 | ~1453 | 消息封装/解包、发送/接收、序号管理 |
| adapter_protocol_ufcs_handle.c | 事件层 | ~367 | 处理适配器主动消息、测试请求 |
| adapter_protocol_ufcs_interface.c | 硬件层 | ~313 | 硬件抽象、ops 注册与调用 |
| adapter_protocol_ufcs_auth.c | 认证层 | ~177 | Hash 认证、用户态通信 |
| adapter_protocol_ufcs_base.h | 基础头 | - | 消息层接口定义 |
| adapter_protocol_ufcs_handle.h | 事件头 | - | 事件处理接口定义 |
| adapter_protocol_ufcs_interface.h | 接口头 | - | 硬件层接口定义 |

**总代码量**: ~3500+ 行

### 2.3 UFCS 消息类型

```
UFCS 协议消息类型:
├── Control Message (控制消息)
│   ├── PING                   - 心跳检测
│   ├── ACK/NCK                - 确认/否认
│   ├── ACCEPT                 - 接受请求
│   ├── SOFT_RESET             - 软复位
│   ├── POWER_READY            - 功率就绪
│   ├── GET_OUTPUT_CAPABILITIES - 获取输出能力
│   ├── GET_SOURCE_INFO        - 获取源信息
│   ├── GET_SINK_INFO          - 获取接收端信息
│   ├── GET_CABLE_INFO         - 获取线缆信息
│   ├── GET_DEVICE_INFO        - 获取设备信息
│   ├── GET_ERROR_INFO         - 获取错误信息
│   ├── DETECT_CABLE_INFO      - 检测线缆信息
│   ├── START_CABLE_DETECT     - 开始线缆检测
│   ├── END_CABLE_DETECT       - 结束线缆检测
│   └── EXIT_UFCS_MODE         - 退出 UFCS 模式
│
├── Data Message (数据消息)
│   ├── OUTPUT_CAPABILITIES    - 输出能力数据
│   ├── REQUEST                - 请求数据
│   ├── SOURCE_INFO            - 源信息数据
│   ├── SINK_INFO              - 接收端信息数据
│   ├── CABLE_INFO             - 线缆信息数据
│   ├── DEVICE_INFO            - 设备信息数据
│   ├── ERROR_INFO             - 错误信息数据
│   ├── CONFIG_WATCHDOG        - 看门狗配置
│   ├── REFUSE                 - 拒绝数据
│   ├── VERIFY_REQUEST         - 验证请求
│   ├── VERIFY_RESPONSE        - 验证响应
│   ├── POWER_CHANGE           - 功率变化通知
│   └── TEST_REQUEST           - 测试请求
│
└── Vendor Defined Message (厂商自定义消息)
    ├── GET_SOURCE_ID          - 获取源 ID
    └── GET_SCPB_POWER         - 获取 SCP-B 功率
```

---

## 三、核心数据结构

### 3.1 设备管理结构

```c
struct hwufcs_dev {
    struct device *dev;                    // 设备对象
    struct hwufcs_info info;               // 适配器信息缓存
    struct notifier_block event_nb;        // 事件通知块
    int dev_id;                            // 设备 ID
    bool plugged_state;                    // 插入状态
    bool is_in_test_mode;                  // 测试模式标志
};

struct hwufcs_info {
    /* 输出能力 */
    struct hwufcs_capabilities_data cap[HWUFCS_CAP_MAX_OUTPUT_MODE];  // 15 组
    u8 cap_num;                            // 能力组数量
    int outout_capabilities_rd_flag;       // 已读取标志
    
    /* 设备信息 */
    struct hwufcs_dev_info_data dev_info;  // 设备信息
    int dev_info_rd_flag;                  // 已读取标志
    
    /* 功率曲线 */
    struct adp_pwr_curve_para pwr_curve[HWUFCS_POWER_CURVE_SIZE];  // 32 组
    unsigned int pwr_curve_size;           // 曲线点数
};
```

### 3.2 消息包结构

```c
struct hwufcs_package_data {
    /* 消息头部 */
    u8 msg_type;                           // 消息类型 (Control/Data/VDM)
    u8 prot_version;                       // 协议版本 (0x1)
    u8 msg_number;                         // 消息序号 (0~15 循环)
    u8 dev_address;                        // 设备地址 (Source/Sink/Cable)
    
    /* 消息体 */
    u8 cmd;                                // 命令码
    u8 len;                                // 数据长度
    u8 data[HWUFCS_MSG_MAX_BUFFER_SIZE];   // 数据缓冲区 (256 字节)
};
```

### 3.3 输出能力结构

```c
struct hwufcs_capabilities_data {
    /* 电流范围 */
    u8 min_curr;                           // 最小电流 (10mA 单位)
    u16 max_curr;                          // 最大电流 (10mA 单位)
    
    /* 电压范围 */
    u16 min_volt;                          // 最小电压 (10mV 单位)
    u16 max_volt;                          // 最大电压 (10mV 单位)
    
    /* 调节步进 */
    u8 volt_step;                          // 电压步进 (0=10mV, 1=20mV)
    u8 curr_step;                          // 电流步进 (0~7)
    
    /* 输出模式 */
    u8 output_mode;                        // 输出模式 (0~15)
};

/* 示例: 66W 适配器输出能力
 * Mode 0: 5V 1A~3A        (15W)
 * Mode 1: 9V 1A~3A        (27W)
 * Mode 2: 11V 1A~6A       (66W)
 * Mode 3: 12V 1A~5A       (60W)
 */
```

### 3.4 请求数据结构

```c
struct hwufcs_request_data {
    u16 output_volt;                       // 请求电压 (10mV 单位)
    u16 output_curr;                       // 请求电流 (10mA 单位)
    u8 output_mode;                        // 请求输出模式
};
```

### 3.5 硬件操作接口

```c
struct hwufcs_ops {
    const char *chip_name;                 // 芯片名称
    void *dev_data;                        // 私有数据
    
    /* 适配器检测 */
    int (*detect_adapter)(void *dev_data);
    
    /* 消息收发 */
    int (*write_msg)(void *dev_data, u8 *data, u8 len, u8 flag);
    int (*read_msg)(void *dev_data, u8 *data, u8 len);
    int (*wait_msg_ready)(void *dev_data, u8 flag);
    int (*get_rx_len)(void *dev_data, u8 *len);
    int (*end_read_msg)(void *dev_data);
    
    /* 复位控制 */
    int (*soft_reset_master)(void *dev_data);
    int (*hard_reset_mask)(void *dev_data, u8 mask);
    int (*hard_reset_cable)(void *dev_data);
    
    /* 通信控制 */
    int (*set_communicating_flag)(void *dev_data, bool flag);
    int (*config_baud_rate)(void *dev_data, int baud_rate);
    int (*clear_rx_buff)(void *dev_data);
    
    /* 功能查询 */
    bool (*need_check_ack)(void *dev_data);
    bool (*ignore_get_cable_info)(void *dev_data);
};
```

---

## 四、核心功能实现

### 4.1 消息封装与解包

#### 4.1.1 消息头部封装

```c
static void hwufcs_packet_head(struct hwufcs_package_data *pkt, u8 *buf)
{
    u16 data = 0;
    
    /* 构造消息头 (16 bits) */
    // bit0~2: 消息类型 (Control/Data/VDM)
    data |= ((pkt->msg_type & 0x7) << 0);
    
    // bit3~8: 协议版本 (0x1)
    data |= ((pkt->prot_version & 0x3f) << 3);
    
    // bit9~12: 消息序号 (0~15 循环)
    data |= ((pkt->msg_number & 0xf) << 9);
    
    // bit13~15: 设备地址 (Source/Sink/Cable)
    data |= ((pkt->dev_address & 0x7) << 13);
    
    /* 填充到缓冲区 (大端序) */
    buf[0] = (data >> 8) & 0xFF;  // 高字节
    buf[1] = (data >> 0) & 0xFF;  // 低字节
}
```

#### 4.1.2 控制消息发送

```c
int hwufcs_send_control_msg(u8 cmd, bool ack)
{
    int ret;
    u8 buf[HWUFCS_MSG_MAX_BUFFER_SIZE];
    struct hwufcs_package_data pkt;
    
    /* 构造消息包 */
    memset(&pkt, 0, sizeof(pkt));
    pkt.msg_type = HWUFCS_MSG_TYPE_CONTROL;
    pkt.prot_version = HWUFCS_MSG_PROT_VERSION;  // 0x1
    pkt.msg_number = hwufcs_get_msg_number();
    pkt.dev_address = HWUFCS_DEV_ADDRESS_SOURCE;
    pkt.cmd = cmd;
    pkt.len = 0;  // 控制消息无数据
    
    /* 封装消息头 */
    hwufcs_packet_head(&pkt, buf);
    
    /* 填充命令码和长度 */
    buf[2] = pkt.cmd;
    buf[3] = pkt.len;
    
    /* 发送消息 */
    ret = hwufcs_write_msg(buf, HWUFCS_HDR_HEADER_LEN + 
        HWUFCS_MSG_CMD_LEN + HWUFCS_MSG_LENGTH_LEN,
        HWUFCS_WAIT_SEND_PACKET_COMPLETE);
    
    /* 等待 ACK */
    if (ack && !ret)
        ret = hwufcs_receive_control_msg(HWUFCS_CTL_MSG_ACK, true);
    
    /* 更新消息序号 */
    hwufcs_set_msg_number(pkt.msg_number + 1);
    
    return ret;
}
```

#### 4.1.3 数据消息接收

```c
int hwufcs_receive_output_capabilities_data_msg(
    struct hwufcs_capabilities_data *p, u8 *ret_len)
{
    int i, ret;
    struct hwufcs_package_data pkt;
    u64 data;
    u64 tmp_data;
    
    /* 接收消息 */
    ret = hwufcs_receive_msg(&pkt, true);
    if (ret)
        return ret;
    
    /* 验证消息类型 */
    if (pkt.cmd != HWUFCS_DATA_MSG_OUTPUT_CAPABILITIES)
        return HWUFCS_ERR_UNEXPECT_DATA;
    
    /* 验证数据长度 (每组 8 字节) */
    if ((pkt.len % 8) != 0)
        return HWUFCS_ERR_ILLEGAL_DATA;
    
    /* 解析输出能力 */
    *ret_len = pkt.len / 8;
    for (i = 0; i < *ret_len; i++) {
        memcpy((u8 *)&data, &pkt.data[i * 8], 8);
        tmp_data = cpu_to_be64(data);
        
        /* 提取各字段 (按协议位域定义) */
        p[i].min_curr = (tmp_data >> 0) & 0xFF;
        p[i].max_curr = (tmp_data >> 8) & 0xFFFF;
        p[i].min_volt = (tmp_data >> 24) & 0xFFFF;
        p[i].max_volt = (tmp_data >> 40) & 0xFFFF;
        p[i].volt_step = (tmp_data >> 56) & 0x1;
        p[i].curr_step = (tmp_data >> 57) & 0x7;
        p[i].output_mode = (tmp_data >> 60) & 0xF;
        
        hwlog_info("cap[%d]: %umV~%umV %umA~%umA mode=%u\n", i,
            p[i].min_volt * 10, p[i].max_volt * 10,
            p[i].min_curr * 10, p[i].max_curr * 10,
            p[i].output_mode);
    }
    
    return 0;
}
```

### 4.2 功率协商流程

#### 4.2.1 获取输出能力

```c
static int hwufcs_cmd_get_output_capabilities(void *p)
{
    int ret;
    struct hwufcs_dev *l_dev = (struct hwufcs_dev *)p;
    
    /* 发送 Get Output Capabilities 控制消息 */
    ret = hwufcs_send_control_msg(
        HWUFCS_CTL_MSG_GET_OUTPUT_CAPABILITIES, true);
    if (ret)
        return ret;
    
    /* 接收 Output Capabilities 数据消息 */
    ret = hwufcs_receive_output_capabilities_data_msg(
        l_dev->info.cap, &l_dev->info.cap_num);
    if (ret)
        return ret;
    
    hwlog_info("get %u output capabilities\n", l_dev->info.cap_num);
    return 0;
}
```

#### 4.2.2 请求输出电压电流

```c
static int hwufcs_set_output_voltage(int volt)
{
    struct hwufcs_dev *l_dev = hwufcs_get_dev();
    struct hwufcs_request_data data;
    int ret;
    
    /* 构造请求数据 */
    data.output_volt = volt / 10;  // mV → 10mV 单位
    data.output_curr = l_dev->last_curr / 10;  // 使用上次电流
    data.output_mode = HWUFCS_REQ_BASE_OUTPUT_MODE;
    
    /* 发送 Request 数据消息 */
    ret = hwufcs_send_request_data_msg(&data);
    if (ret)
        return -EPERM;
    
    /* 等待 Accept 控制消息 */
    ret = hwufcs_receive_control_msg(HWUFCS_CTL_MSG_ACCEPT, true);
    if (ret)
        return -EPERM;
    
    /* 等待 Power Ready 控制消息 */
    for (i = 0; i < HWUFCS_POWER_READY_RETRY; i++) {
        ret = hwufcs_receive_control_msg(
            HWUFCS_CTL_MSG_POWER_READY, false);
        if (!ret)
            break;
        power_usleep(DT_USLEEP_10MS);
    }
    
    hwlog_info("set voltage to %dmV\n", volt);
    return ret;
}
```

### 4.3 事件处理机制

#### 4.3.1 Ping 消息处理

```c
static void hwufcs_handle_ping(struct hwufcs_package_data *pkt)
{
    hwlog_info("handle ping msg\n");
    
    /* 回复 ACK */
    hwufcs_send_control_msg(HWUFCS_CTL_MSG_ACK, false);
}
```

#### 4.3.2 Get Sink Info 处理

```c
static void hwufcs_handle_get_sink_info(struct hwufcs_package_data *pkt)
{
    int ret;
    struct hwufcs_sink_info_data data;
    
    hwlog_info("handle get_sink_info msg\n");
    
    /* 获取实时充电状态 */
    data.bat_curr = power_supply_app_get_bat_current_now();
    data.bat_volt = power_supply_app_get_bat_voltage_now();
    data.bat_temp = power_supply_app_get_bat_temp();
    data.usb_temp = power_temp_get_average_value(POWER_TEMP_USB_PORT) / 1000;
    
    /* 发送 Sink Info 数据消息 */
    ret = hwufcs_send_sink_information_data_msg(&data);
    if (ret)
        hwufcs_send_control_msg(HWUFCS_CTL_MSG_SOFT_RESET, true);
}
```

#### 4.3.3 Power Change 事件

```c
static void hwufcs_handle_power_change(struct hwufcs_package_data *pkt)
{
    int ret;
    
    hwlog_info("handle power_change msg\n");
    
    /* 解析功率变化数据 */
    ret = hwufcs_updata_power_change_data(pkt);
    if (ret) {
        hwufcs_send_refuse_data_msg(
            HWUFCS_REFUSE_REASON_NOT_IDENTIFY, pkt);
        return;
    }
    
    /* 缓存功率变化信息 */
    // g_power_change_data[] 已更新
    
    /* 触发充电策略调整 */
    power_event_bnc_notify(POWER_BNT_UFCS_POWER_CHANGE, NULL);
}
```

### 4.4 认证机制

#### 4.4.1 加密认证流程

```c
static int hwufcs_auth_encrypt_start(int key)
{
    int ret;
    struct hwufcs_verify_request_data req_data;
    struct hwufcs_verify_response_data rsp_data;
    u8 hash_data[HWUFCS_AUTH_HASH_LEN];
    
    /* Step 1: 生成随机数 */
    get_random_bytes(req_data.random_num, 16);
    req_data.encrypt_index = key;
    
    /* Step 2: 发送 Verify Request */
    ret = hwufcs_send_verify_request_data_msg(&req_data);
    if (ret)
        return -EPERM;
    
    /* Step 3: 等待 Accept */
    ret = hwufcs_receive_control_msg(HWUFCS_CTL_MSG_ACCEPT, true);
    if (ret)
        return -EPERM;
    
    /* Step 4: 接收 Verify Response */
    ret = hwufcs_receive_verify_response_data_msg(&rsp_data);
    if (ret)
        return -EPERM;
    
    /* Step 5: 组装验证数据 */
    // hash_data = [随机数(16)] + [Hash(16)] + [密钥索引(1)]
    memcpy(hash_data, req_data.random_num, 16);
    memcpy(hash_data + 16, rsp_data.encrypted_value, 16);
    hash_data[32] = key;
    
    /* Step 6: 发送到用户态验证 */
    hwufcs_auth_clean_hash_data();
    memcpy(hwufcs_auth_get_hash_data_header(), hash_data, 33);
    ret = hwufcs_auth_wait_completion();
    
    hwlog_info("auth result=%d\n", ret);
    return ret;
}
```

### 4.5 测试模式支持

```c
static void hwufcs_handle_test_request(struct hwufcs_package_data *pkt)
{
    struct hwufcs_test_request_data test_data;
    
    hwlog_info("handle test_request msg\n");
    
    /* 检查是否在测试模式 */
    if (!hwufcs_handle_in_test_mode()) {
        hwlog_err("non test mode, refuse test request\n");
        hwufcs_send_refuse_data_msg(
            HWUFCS_REFUSE_REASON_NOT_SUPPORT, pkt);
        return;
    }
    
    /* 解析测试请求 */
    hwufcs_parse_test_request_data(&test_data, pkt);
    
    /* 处理测试命令 */
    switch (test_data.msg_type) {
    case HWUFCS_MSG_TYPE_CONTROL:
        hwufcs_handle_test_request_control_msg(test_data.msg_cmd, pkt);
        break;
    case HWUFCS_MSG_TYPE_DATA:
        hwufcs_handle_test_request_data_msg(test_data.msg_cmd, pkt);
        break;
    default:
        hwufcs_send_refuse_data_msg(
            HWUFCS_REFUSE_REASON_NOT_SUPPORT, pkt);
        break;
    }
}
```

---

## 五、典型使用场景

### 场景 1: UFCS 适配器检测与初始化

```c
/* Direct Charge 调用 UFCS 协议 */
static int dc_init_ufcs_adapter(void)
{
    int ret, mode;
    
    /* Step 1: 检测 UFCS 适配器 */
    ret = adapter_detect_support_mode(ADAPTER_PROTOCOL_UFCS, &mode);
    if (ret != ADAPTER_DETECT_SUCC) {
        hwlog_err("UFCS adapter not detected\n");
        return -EPERM;
    }
    
    /* Step 2: 获取输出能力 */
    struct hwufcs_capabilities_data cap[15];
    u8 cap_num;
    ret = hwufcs_get_output_capabilities(cap, &cap_num);
    
    /* Step 3: 打印所有输出模式 */
    for (i = 0; i < cap_num; i++) {
        hwlog_info("Mode %u: %umV~%umV %umA~%umA\n", i,
            cap[i].min_volt * 10, cap[i].max_volt * 10,
            cap[i].min_curr * 10, cap[i].max_curr * 10);
    }
    // 输出示例:
    // Mode 0: 5000mV~5000mV 100mA~3000mA
    // Mode 1: 9000mV~9000mV 100mA~3000mA
    // Mode 2: 11000mV~11000mV 100mA~6000mA
    
    /* Step 4: 选择最高功率模式 (11V 6A = 66W) */
    ret = adapter_set_output_voltage(ADAPTER_PROTOCOL_UFCS, 11000);
    ret = adapter_set_output_current(ADAPTER_PROTOCOL_UFCS, 6000);
    
    return 0;
}
```

### 场景 2: 动态功率调整

```c
/* 根据电池状态动态调整功率 */
static void ufcs_dynamic_power_adjust(void)
{
    int bat_temp, bat_volt, bat_curr;
    int target_volt, target_curr;
    
    /* 获取电池状态 */
    bat_temp = power_supply_app_get_bat_temp();
    bat_volt = power_supply_app_get_bat_voltage_now();
    bat_curr = power_supply_app_get_bat_current_now();
    
    /* 温度保护策略 */
    if (bat_temp > 45) {
        /* 高温降功率 */
        target_volt = 9000;  // 降到 9V
        target_curr = 3000;  // 限流 3A
    } else if (bat_volt > 4200) {
        /* 恒压阶段 */
        target_volt = 11000;
        target_curr = 2000;  // 减小电流
    } else {
        /* 恒流阶段 */
        target_volt = 11000;
        target_curr = 6000;  // 最大功率
    }
    
    /* 发送请求 */
    adapter_set_output_voltage(ADAPTER_PROTOCOL_UFCS, target_volt);
    adapter_set_output_current(ADAPTER_PROTOCOL_UFCS, target_curr);
}
```

### 场景 3: 适配器认证

```c
/* 执行 UFCS 适配器认证 */
static int ufcs_adapter_authentication(void)
{
    int ret, key_index = 2;  // 使用密钥索引 2
    
    /* 发起认证 */
    ret = adapter_auth_encrypt_start(ADAPTER_PROTOCOL_UFCS, key_index);
    if (ret == 0) {
        hwlog_info("UFCS adapter authentication SUCCESS\n");
        
        /* 获取设备信息 */
        struct adapter_device_info info;
        adapter_get_device_info(ADAPTER_PROTOCOL_UFCS, &info);
        
        hwlog_info("Vendor: 0x%04x, HW Ver: 0x%02x, SW Ver: 0x%04x\n",
            info.vendor_id, info.hwver, info.fwver);
    } else {
        hwlog_err("UFCS authentication FAILED - Fake adapter!\n");
        /* 限制充电功率或停止充电 */
        adapter_set_default_state(ADAPTER_PROTOCOL_UFCS);
    }
    
    return ret;
}
```

### 场景 4: Power Change 事件响应

```c
/* 处理适配器功率变化事件 */
static int ufcs_power_change_handler(struct notifier_block *nb,
    unsigned long event, void *data)
{
    int curr;
    unsigned int mode;
    
    if (event != POWER_BNT_UFCS_POWER_CHANGE)
        return NOTIFY_OK;
    
    /* 查询当前输出模式的最大电流 */
    mode = get_current_output_mode();
    curr = hwufcs_get_power_change_curr(mode);
    
    hwlog_info("Power change: mode=%u max_curr=%umA\n", mode, curr);
    
    /* 调整充电策略 */
    if (curr < 3000) {
        /* 适配器功率下降，降低充电电流 */
        adapter_set_output_current(ADAPTER_PROTOCOL_UFCS, curr);
    }
    
    return NOTIFY_OK;
}
```

### 场景 5: 测试模式 (认证测试)

```c
/* 进入 UFCS 测试模式 */
static void ufcs_enter_test_mode(void)
{
    /* 使能测试模式 */
    hwufcs_handle_set_test_mode(true);
    
    hwlog_info("UFCS entered test mode\n");
    
    /* 测试模式下，适配器可发送 Test Request */
    // - 手机自动响应指定的电压/电流
    // - 自动回复 Get Output Capabilities 等命令
    // - 用于 UFCS 认证测试
}

/* 示例: Test Request 消息处理 */
// 适配器发送: Test Request (Request 8V 1A)
// 手机自动回复: Request (8000mV, 1000mA, mode=0)
// 适配器发送: Accept
// 适配器发送: Power Ready
// 测试通过
```

---

## 六、调试方法

### 6.1 Kernel 日志分析

#### 关键日志标签
```bash
# 过滤 UFCS 协议日志
adb shell dmesg | grep "ufcs_protocol"
adb shell dmesg | grep "hwufcs"

# 分层日志
adb shell dmesg | grep "ufcs_protocol_handle"    # 事件处理层
adb shell dmesg | grep "ufcs_protocol_interface" # 硬件接口层
```

#### 典型日志输出

**检测流程**:
```
[  10.100] ufcs_protocol_interface: detect_adapter
[  10.150] ufcs_protocol: send ctl_msg: get_output_capabilities
[  10.200] ufcs_protocol: receive data_msg: output_capabilities
[  10.205] ufcs_protocol: cap[0]: 5000mV~5000mV 100mA~3000mA mode=0
[  10.210] ufcs_protocol: cap[1]: 9000mV~9000mV 100mA~3000mA mode=1
[  10.215] ufcs_protocol: cap[2]: 11000mV~11000mV 100mA~6000mA mode=2
[  10.220] ufcs_protocol: get 3 output capabilities
```

**功率协商**:
```
[  15.000] ufcs_protocol: send data_msg: request volt=11000 curr=6000
[  15.050] ufcs_protocol: receive ctl_msg: accept
[  15.100] ufcs_protocol: receive ctl_msg: power_ready
[  15.105] ufcs_protocol: set voltage to 11000mV
```

**事件处理**:
```
[  20.000] ufcs_protocol_handle: handle ping msg
[  20.100] ufcs_protocol_handle: handle get_sink_info msg
[  20.105] ufcs_protocol: bat_curr=5000mA bat_volt=4000mV bat_temp=35C
[  20.200] ufcs_protocol_handle: handle power_change msg
[  20.205] ufcs_protocol: power_change[0]=5000mA mode=2
```

**认证流程**:
```
[  25.000] ufcs_protocol: send data_msg: verify_request
[  25.050] ufcs_protocol: receive ctl_msg: accept
[  25.100] ufcs_protocol: receive data_msg: verify_response
[  25.200] ufcs_protocol: hash calculate ok
[  25.205] ufcs_protocol: auth result=0 (success)
```

### 6.2 消息序号追踪

```bash
# 追踪消息序号变化
adb shell dmesg | grep "msg_number"

# 输出:
# old_msg_number=0 new_msg_number=1
# old_msg_number=1 new_msg_number=2
# old_msg_number=2 new_msg_number=3
# ...
# old_msg_number=15 new_msg_number=0  # 循环到 0
```

### 6.3 常见问题诊断

| **现象** | **可能原因** | **检查方法** | **解决方案** |
|---------|------------|------------|------------|
| 检测失败 | 非 UFCS 适配器 | 检查 detect_adapter 返回值 | 确认适配器支持 UFCS |
| 消息超时 | 通信异常 | 检查波特率配置 | 重新配置波特率或复位 |
| CRC 错误 | 数据损坏 | 检查线缆质量 | 更换线缆或降低波特率 |
| 功率协商失败 | 请求参数超范围 | 对比 capabilities | 调整请求参数到有效范围 |
| 认证失败 | 用户态服务未响应 | 检查 power_genl 服务 | 启动防伪服务 |
| 消息序号错误 | 序号不匹配 | 检查 msg_number | 执行 Soft Reset |
| Power Ready 超时 | 适配器调压慢 | 增加等待时间 | 增大 POWER_READY_RETRY |

### 6.4 错误码参考

```c
/* 检测错误码 */
HWUFCS_DETECT_OTHER = -1    // 非 UFCS 适配器
HWUFCS_DETECT_SUCC = 0      // 检测成功
HWUFCS_DETECT_FAIL = 1      // 通信失败

/* 通信错误码 */
HWUFCS_OK = 0               // 成功
HWUFCS_NEED_RETRY = 1       // 需要重试
HWUFCS_FAIL = 2             // 失败

HWUFCS_ERR_TIMEOUT = 0x1    // 超时
HWUFCS_ERR_UNEXPECT_DATA = 0x2   // 意外数据
HWUFCS_ERR_REFUSED_DATA = 0x3    // 拒绝数据
HWUFCS_ERR_ILLEGAL_DATA = 0x4    // 非法数据
HWUFCS_ERR_UNSUPPORT_DATA = 0x5  // 不支持数据

/* 拒绝原因 */
HWUFCS_REFUSE_REASON_NOT_IDENTIFY = 0x1   // 无法识别
HWUFCS_REFUSE_REASON_NOT_SUPPORT = 0x2    // 不支持
```

---

## 七、性能优化与最佳实践

### 7.1 命令重试机制

```c
static int hwufcs_cmd_retry(int cmd, void *p)
{
    int i, ret;
    int cnt = 0;
    
    do {
        /* 执行命令 */
        ret = g_ufcs_cmd_data[i].cmd_cb(p);
        
        /* 成功或彻底失败则退出 */
        if ((ret == HWUFCS_OK) || (ret == HWUFCS_FAIL))
            break;
        
        /* 检查插入状态 */
        if (!g_hwufcs_dev->plugged_state)
            break;
        
        /* Soft Reset 后重试 */
        if (hwufcs_soft_reset_slave())
            break;
        
    } while (cnt++ < 3);  // 最多重试 3 次
    
    return ret;
}
```

### 7.2 消息序号管理

```c
/* 线程安全的序号管理 */
static u8 hwufcs_get_msg_number(void)
{
    u8 msg_number;
    
    mutex_lock(&g_msg_number_lock);
    msg_number = g_msg_number;
    mutex_unlock(&g_msg_number_lock);
    
    return msg_number;
}

static void hwufcs_set_msg_number(u8 msg_number)
{
    mutex_lock(&g_msg_number_lock);
    g_msg_number = (msg_number % 16);  // 0~15 循环
    mutex_unlock(&g_msg_number_lock);
}
```

### 7.3 缓存优化

```c
/* 输出能力缓存 */
static int hwufcs_get_output_capabilities(struct hwufcs_dev *l_dev)
{
    /* 检查缓存标志 */
    if (l_dev->info.outout_capabilities_rd_flag == HAS_READ_FLAG)
        return 0;  // 直接返回，避免重复查询
    
    /* 首次查询 */
    ret = hwufcs_cmd_retry(UFCS_CMD_GET_OUTPUT_CAPABILITIES, l_dev);
    if (ret)
        return -EPERM;
    
    /* 标记已读取 */
    l_dev->info.outout_capabilities_rd_flag = HAS_READ_FLAG;
    
    return 0;
}
```

### 7.4 最佳实践建议

**1. 功率协商**:
```c
/* 推荐: 逐步升压 */
adapter_set_output_voltage(ADAPTER_PROTOCOL_UFCS, 5000);   // 5V
msleep(100);
adapter_set_output_voltage(ADAPTER_PROTOCOL_UFCS, 9000);   // 9V
msleep(100);
adapter_set_output_voltage(ADAPTER_PROTOCOL_UFCS, 11000);  // 11V

/* 不推荐: 直接跳到最高电压 */
adapter_set_output_voltage(ADAPTER_PROTOCOL_UFCS, 11000);  // 可能失败
```

**2. 错误恢复**:
```c
/* Soft Reset 恢复策略 */
if (ret == HWUFCS_NEED_RETRY) {
    hwufcs_soft_reset_slave();
    msleep(100);
    /* 重新协商 */
}
```

**3. 看门狗配置**:
```c
struct hwufcs_wtg_data wtg_data;
wtg_data.wtg_time = 5;  // 5 秒超时

/* 定期喂狗 */
hwufcs_config_watchdog(&wtg_data);
```

---

## 八、总结

### 8.1 核心特性总结

| **特性** | **描述** | **技术亮点** |
|---------|---------|------------|
| **协议标准** | CCSA 融合快充 | 中国通信标准化协会标准 |
| **代码规模** | 3500+ 行 | 8 个模块，职责清晰 |
| **消息类型** | 3 大类 | Control/Data/VDM |
| **功率范围** | 15W~240W+ | 最高支持 20V 12A |
| **输出模式** | 最多 15 种 | 灵活电压电流组合 |
| **认证机制** | Hash 加密 | 防伪验证 |
| **事件驱动** | 双向通信 | 适配器主动消息 |
| **芯片支持** | 5 种 | 多平台兼容 |

### 8.2 与其他协议对比

| **特性** | **UFCS** | **SCP** | **PD** |
|---------|---------|---------|---------|
| **标准组织** | CCSA (中国) | 华为 | USB-IF |
| **开放性** | 行业标准 | 私有 | 国际标准 |
| **功率** | 240W+ | 135W | 240W |
| **电压精度** | 10mV | 1mV | 20mV |
| **电流精度** | 10mA | 1mA | 50mA |
| **消息类型** | 丰富 (3 类) | 简单 | 中等 |
| **双向通信** | ✓ | ✗ | ✓ |
| **线缆识别** | ✓ | ✗ | ✓ |
| **测试模式** | ✓ | ✗ | ✗ |

### 8.3 技术创新点

- **统一标准**: 中国融合快充标准，推动行业互通
- **模块化设计**: 8 个模块分层清晰，易于维护
- **双向通信**: 支持适配器主动消息 (Ping/Power Change)
- **灵活功率**: 15 种输出模式，精细化功率管理
- **线缆识别**: 支持电子标签通信，线缆安全检测
- **测试友好**: 内置测试模式，支持标准认证测试
- **事件驱动**: 完整的事件处理机制
- **用户态认证**: Power Genl 通信，安全验证

### 8.4 适用场景

**推荐使用 UFCS**:
- 支持 UFCS 的新适配器
- 跨品牌快充需求
- 需要高功率充电 (>100W)
- 重视标准兼容性
- 中国市场产品

**其他协议选择**:
- **PD**: 国际市场、USB Type-C 设备
- **SCP**: 华为生态、精确电压控制
- **FCP**: 老旧适配器兼容

### 8.5 发展趋势

UFCS 作为中国融合快充标准，旨在统一国内快充协议，实现：
- **跨品牌兼容**: 不同厂商适配器互用
- **高功率支持**: 满足未来超高功率需求
- **安全可靠**: 完善的保护和认证机制
- **标准推广**: 逐步替代私有快充协议
