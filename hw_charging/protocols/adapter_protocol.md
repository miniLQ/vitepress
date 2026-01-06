---
outline: deep
---

# 充电协议抽象层

## 1. 模块定位与核心价值

### 1.1 模块定位
**adapter_protocol** 是华为MATE X5电源管理子系统的**快充协议抽象层**，为多种快充协议（SCP、FCP、PD、UVDM、UFCS）提供**统一的操作接口**。它作为**协议适配器框架**，将不同快充协议的底层实现统一封装，向上层提供标准化的充电器控制API。

### 1.2 核心价值
1. **多协议统一管理**：支持5种主流快充协议的统一接口
2. **解耦协议实现**：通过ops回调机制分离协议具体实现
3. **充电器能力协商**：查询充电器支持的电压/电流范围
4. **动态电压电流控制**：支持运行时调整充电参数
5. **充电器信息查询**：获取型号、温度、功率曲线等信息
6. **安全保护**：温度监控、过流保护、泄漏电流检测

### 1.3 支持的快充协议
```
adapter_protocol 支持的协议类型：
├── ADAPTER_PROTOCOL_SCP   (hw_scp)   - 华为超级快充协议
├── ADAPTER_PROTOCOL_FCP   (hw_fcp)   - 华为快充协议
├── ADAPTER_PROTOCOL_PD    (hw_pd)    - USB Power Delivery
├── ADAPTER_PROTOCOL_UVDM  (hw_uvdm)  - USB VDM (Vendor Defined Message)
└── ADAPTER_PROTOCOL_UFCS  (hw_ufcs)  - 融合快充协议 (Unified Fast Charge)
```

---

## 2. 系统架构

### 2.1 整体架构图
```
┌─────────────────────────────────────────────────────────┐
│          Direct Charge / Wireless Charge Module         │
│          (直充/无线充电业务层)                            │
└────────────────────┬────────────────────────────────────┘
                     │ 调用统一接口
                     │ adapter_set_output_voltage()
                     │ adapter_get_device_info()
┌────────────────────┴────────────────────────────────────┐
│            adapter_protocol (协议抽象层)                 │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Protocol Router (协议路由)                      │   │
│  │  根据prot参数选择对应的ops                       │   │
│  └──────────────────┬───────────────────────────────┘   │
│                     │                                     │
│  ┌──────────────────┴───────────────────────────────┐   │
│  │  ops[ADAPTER_PROTOCOL_SCP]    → SCP协议实现      │   │
│  │  ops[ADAPTER_PROTOCOL_FCP]    → FCP协议实现      │   │
│  │  ops[ADAPTER_PROTOCOL_PD]     → PD协议实现       │   │
│  │  ops[ADAPTER_PROTOCOL_UVDM]   → UVDM协议实现     │   │
│  │  ops[ADAPTER_PROTOCOL_UFCS]   → UFCS协议实现     │   │
│  └──────────────────────────────────────────────────┘   │
└────────────────────┬────────────────────────────────────┘
                     │ 回调ops函数
┌────────────────────┴────────────────────────────────────┐
│            Protocol Implementation Layer                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  SCP Driver  │  │  FCP Driver  │  │  PD Driver   │ │
│  │  (hw_scp.ko) │  │  (hw_fcp.ko) │  │  (hw_pd.ko)  │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │
└─────────┼──────────────────┼──────────────────┼─────────┘
          │                  │                  │
┌─────────┴──────────────────┴──────────────────┴─────────┐
│              Hardware Communication Layer               │
│  (I2C/UART/CC通信，与充电器通信)                        │
└─────────────────────────────────────────────────────────┘
```

### 2.2 设计模式
- **策略模式**：不同协议作为不同策略，通过ops切换
- **工厂模式**：根据协议类型创建对应的操作实例
- **适配器模式**：将不同协议适配为统一接口
- **注册表模式**：通过数组存储各协议的ops

---

## 3. 核心数据结构

### 3.1 协议操作接口（adapter_protocol_ops）
```c
struct adapter_protocol_ops {
    const char *type_name;  // 协议名称："hw_scp"/"hw_fcp"/"hw_pd"等
    
    /* === 复位相关 === */
    int (*soft_reset_master)(void);      // 软复位主机（手机端）
    int (*soft_reset_slave)(void);       // 软复位从机（充电器端）
    int (*soft_reset_dpdm)(void);        // 软复位D+/D-数据线
    int (*hard_reset_master)(void);      // 硬复位主机
    
    /* === 能力协商 === */
    int (*detect_adapter_support_mode)(int *mode);  // 检测充电器支持模式
    int (*get_support_mode)(int *mode);             // 获取支持模式
    int (*get_device_info)(struct adapter_device_info *info);  // 获取设备信息
    
    /* === 输出控制 === */
    int (*set_output_enable)(int enable);        // 使能/禁用输出
    int (*set_output_mode)(int enable);          // 设置输出模式
    int (*set_reset)(int enable);                // 设置复位
    int (*set_output_voltage)(int volt);         // 设置输出电压
    int (*get_output_voltage)(int *volt);        // 获取输出电压
    int (*set_output_current)(int cur);          // 设置输出电流
    int (*get_output_current)(int *cur);         // 获取输出电流
    int (*get_output_current_set)(int *cur);     // 获取电流设定值
    
    /* === 能力查询 === */
    int (*get_min_voltage)(int *volt);           // 最小电压
    int (*get_max_voltage)(int *volt);           // 最大电压
    int (*get_min_current)(int *cur);            // 最小电流
    int (*get_max_current)(int *cur);            // 最大电流
    int (*get_power_drop_current)(int *cur);     // 功率降额电流
    int (*get_power_curve_num)(int *num);        // 功率曲线数量
    int (*get_power_curve)(struct adp_pwr_curve_para *val, ...);  // 功率曲线
    
    /* === 温度监控 === */
    int (*get_inside_temp)(int *temp);           // 充电器内部温度
    int (*get_port_temp)(int *temp);             // 接口温度
    int (*get_source_info)(struct adapter_source_info *info);  // 源信息
    
    /* === 识别信息 === */
    int (*get_chip_vendor_id)(int *id);          // 芯片厂商ID
    int (*get_chip_serial_num)(int *id);         // 芯片序列号
    int (*get_adp_type)(int *type);              // 充电器类型
    int (*get_adp_code)(int *code);              // 充电器代码
    int (*get_source_id)(int *source_id);        // 源ID
    
    /* === 安全检测 === */
    int (*get_port_leakage_current_flag)(int *flag);  // 端口泄漏电流标志
    int (*get_cable_info)(int *curr);            // 线缆信息（额定电流）
    
    /* === 高级功能 === */
    int (*get_scpb_pwr)(struct adp_scpb_pwr_data *scpb_pwr, ...);  // SCPB功率
    int (*auth_encrypt_start)(int key);          // 启动加密认证
    int (*set_usbpd_enable)(int enable, bool check_cport);  // 使能PD
    int (*set_default_state)(void);              // 设置默认状态
    int (*set_default_param)(void);              // 设置默认参数
    int (*set_init_data)(struct adapter_init_data *data);  // 设置初始化数据
    int (*set_slave_power_mode)(int mode);       // 设置从机功率模式
    int (*set_rx_reduce_voltage)(void);          // 接收端降压
    
    /* === 状态查询 === */
    int (*get_protocol_register_state)(void);    // 协议注册状态
    int (*get_slave_status)(void);               // 从机状态
    int (*get_master_status)(void);              // 主机状态
    int (*stop_charging_config)(void);           // 停止充电配置
    
    /* === 判断函数 === */
    bool (*is_accp_charger_type)(void);          // 是否ACCP充电器
    bool (*is_undetach_cable)(void);             // 是否不可拔线缆
    bool (*is_scp_superior)(void);               // 是否SCP优先
};
```

**接口分类统计**：
- 复位控制：4个
- 能力协商：3个
- 输出控制：8个
- 能力查询：7个
- 温度监控：3个
- 识别信息：5个
- 安全检测：2个
- 高级功能：8个
- 状态查询：4个
- 判断函数：3个
- **总计：47个接口**

### 3.2 设备信息结构（adapter_device_info）
```c
struct adapter_device_info {
    int support_mode;     // 支持模式（LVC/SC/SC4/HV）
    int chip_id;          // 芯片ID
    int vendor_id;        // 厂商ID
    int module_id;        // 模块ID
    int serial_no;        // 序列号
    int hwver;            // 硬件版本
    int fwver;            // 固件版本
    int min_volt;         // 最小电压(mV)
    int max_volt;         // 最大电压(mV)
    int min_cur;          // 最小电流(mA)
    int max_cur;          // 最大电流(mA)
    int max_ierr;         // 最大电流误差
    int adp_type;         // 充电器类型
    int adp_code;         // 充电器代码
    int volt_cap;         // 电压能力
    int max_pwr;          // 最大功率
    int volt_step;        // 电压步进(mV)
    int curr_step;        // 电流步进(mA)
    int output_mode;      // 输出模式
};
```

### 3.3 充电器类型枚举（部分）
```c
enum adapter_support_type {
    ADAPTER_TYPE_UNKNOWN = 0x0,
    
    /* 标准充电器 */
    ADAPTER_TYPE_9V2A,              // 9V2A (18W)
    ADAPTER_TYPE_5V4P5A,            // 5V4.5A (22.5W)
    ADAPTER_TYPE_10V4A,             // 10V4A (40W)
    ADAPTER_TYPE_10V2A,             // 10V2A (20W)
    
    /* 高功率充电器 */
    ADAPTER_TYPE_20V3P25A_MAX,      // 20V3.25A (65W)
    ADAPTER_TYPE_20V3P25A,          // 20V3.25A (65W)
    ADAPTER_TYPE_11V6A,             // 11V6A (66W)
    
    /* 双口充电器系列（钱塘江） */
    ADAPTER_TYPE_QTR_C_20V3A,       // TypeC口：20V3A
    ADAPTER_TYPE_QTR_C_10V4A,       // TypeC口：10V4A
    ADAPTER_TYPE_QTR_A_10V4A,       // TypeA口：10V4A
    ADAPTER_TYPE_QTR_A_10V2P25A,    // TypeA口：10V2.25A
    
    /* 三口充电器系列（黄浦江） */
    ADAPTER_TYPE_HPR_C_11V6A,       // TypeC1：11V6A
    ADAPTER_TYPE_HPR_C_10V4A,       // TypeC1：10V4A
    ADAPTER_TYPE_HPR_A_11V6A,       // TypeA1：11V6A
    ADAPTER_TYPE_HPR_A_10V4A,       // TypeA1：10V4A
    
    /* 车载/移动电源 */
    ADAPTER_TYPE_10V4A_CAR,         // 车载10V4A
    ADAPTER_TYPE_11V6A_CAR,         // 车载11V6A
    ADAPTER_TYPE_10V4A_BANK,        // 移动电源10V4A
    ADAPTER_TYPE_11V6A_BANK,        // 移动电源11V6A
    
    /* 最新系列 */
    ADAPTER_TYPE_JLR_20V6P7A,       // 嘉陵江：20V6.7A (134W)
    ADAPTER_TYPE_HHR_20V4P5A,       // 淮河：20V4.5A (90W)
    ADAPTER_TYPE_YLR_20V5A_CAR,     // 鸭绿江车载：20V5A (100W)
    ADAPTER_TYPE_FRO_20V4P4A,       // 20V4.4A (88W)
    // ... 更多型号
};
```

**命名规则**：
- 电压×电流表示功率等级
- `_CAR`后缀：车载充电器
- `_BANK`后缀：移动电源
- 河流名称：华为内部代号（如QTR钱塘江、HPR黄浦江、JLR嘉陵江）

### 3.4 支持模式枚举
```c
enum adapter_support_mode {
    ADAPTER_SUPPORT_UNDEFINED = 0x0,
    ADAPTER_SUPPORT_LVC = 0x1,      // 低压直充 (Low Voltage Charge)
    ADAPTER_SUPPORT_SC = 0x2,       // 标准直充 (Standard Charge, 2:1)
    ADAPTER_SUPPORT_SC4 = 0x4,      // 4:1直充 (4:1 Charge)
    ADAPTER_SUPPORT_HV = 0x8,       // 高压充电 (High Voltage)
    ADAPTER_TEST_MODE = 0X10,       // 测试模式
};
```

**模式说明**：
- **LVC (1:1)**：VBUS直接给电池充电，效率约85%
- **SC (2:1)**：充电IC将电压降为1/2，电流翻倍，效率约95%
- **SC4 (4:1)**：电压降为1/4，电流×4，用于超高功率快充
- **HV**：传统高压充电（9V/12V）

### 3.5 功率曲线结构
```c
struct adp_pwr_curve_para {
    int volt;  // 电压(mV)
    int cur;   // 电流(mA)
};

// 示例：11V6A充电器的功率曲线
struct adp_pwr_curve_para curve_11v6a[] = {
    { 11000, 6000 },  // 11V 6A (66W)
    { 10000, 4000 },  // 10V 4A (40W)
    { 5500,  4000 },  // 5.5V 4A (22W)
    { 5000,  2000 },  // 5V 2A (10W)
};
```

### 3.6 管理结构（adapter_protocol_dev）
```c
struct adapter_protocol_dev {
    struct adapter_device_info info;  // 充电器设备信息
    unsigned int total_ops;           // 已注册的协议数量
    struct adapter_protocol_ops *p_ops[ADAPTER_PROTOCOL_END];  // 5个协议ops
};
```

---

## 4. 核心功能实现

### 4.1 协议注册
```c
int adapter_protocol_ops_register(struct adapter_protocol_ops *ops)
{
    int type;
    
    // 1. 参数检查
    if (!g_adapter_protocol_dev || !ops || !ops->type_name)
        return -EPERM;

    // 2. 根据类型名查找类型ID
    type = adapter_get_protocol_type(ops->type_name);
    // "hw_scp" → ADAPTER_PROTOCOL_SCP
    // "hw_fcp" → ADAPTER_PROTOCOL_FCP
    // "hw_pd"  → ADAPTER_PROTOCOL_PD
    
    if (type < 0)
        return -EPERM;

    // 3. 注册到全局ops数组
    g_adapter_protocol_dev->p_ops[type] = ops;
    g_adapter_protocol_dev->total_ops++;

    hwlog_info("total_ops=%d type=%d:%s ops register ok\n",
        g_adapter_protocol_dev->total_ops, type, ops->type_name);

    return 0;
}
```

**使用示例（SCP协议注册）**：
```c
// 在hw_scp.c中
static struct adapter_protocol_ops scp_protocol_ops = {
    .type_name = "hw_scp",
    .soft_reset_master = scp_soft_reset_master,
    .get_device_info = scp_get_device_info,
    .set_output_voltage = scp_set_output_voltage,
    .get_output_voltage = scp_get_output_voltage,
    // ... 其他回调
};

static int scp_probe(struct platform_device *pdev)
{
    // ... 初始化 ...
    
    ret = adapter_protocol_ops_register(&scp_protocol_ops);
    if (ret)
        hwlog_err("register scp protocol failed\n");
    
    return ret;
}
```

### 4.2 协议路由机制
```c
// 所有接口函数都遵循相同的路由模式
int adapter_set_output_voltage(int prot, int volt)
{
    // 1. 根据协议类型获取ops
    struct adapter_protocol_ops *l_ops = adapter_get_protocol_ops(prot);
    
    if (!l_ops)
        return -EPERM;

    // 2. 检查回调是否实现
    if (!l_ops->set_output_voltage) {
        hwlog_err("set_output_voltage is null\n");
        return -EPERM;
    }

    // 3. 调用协议特定的实现
    return l_ops->set_output_voltage(volt);
}

static struct adapter_protocol_ops *adapter_get_protocol_ops(int prot)
{
    // 检查协议类型有效性
    if (adapter_check_protocol_type(prot))
        return NULL;

    // 从全局数组获取对应的ops
    if (!g_adapter_protocol_dev || !g_adapter_protocol_dev->p_ops[prot])
        return NULL;

    return g_adapter_protocol_dev->p_ops[prot];
}
```

### 4.3 充电器能力协商流程
```c
// 典型的充电器初始化流程
int adapter_detect_and_init(int prot)
{
    int ret;
    int mode = 0;
    struct adapter_device_info info;
    
    // 步骤1：检测充电器支持模式
    ret = adapter_detect_adapter_support_mode(prot, &mode);
    if (ret) {
        hwlog_err("detect support mode fail\n");
        return ret;
    }
    hwlog_info("adapter support mode: 0x%x\n", mode);
    // 输出示例：0x6 (ADAPTER_SUPPORT_SC | ADAPTER_SUPPORT_SC4)
    
    // 步骤2：获取充电器详细信息
    ret = adapter_get_device_info(prot);
    if (ret) {
        hwlog_err("get device info fail\n");
        return ret;
    }
    
    // 步骤3：显示充电器信息
    adapter_show_device_info(prot);
    // 输出示例（SCP协议）：
    // support_mode=0x6
    // vendor_id=0x12345678
    // max_volt=11000  (11V)
    // max_cur=6000    (6A)
    // adp_type=11     (ADAPTER_TYPE_11V6A)
    
    return 0;
}
```

### 4.4 动态电压调节
```c
// 直充过程中的动态调压
int direct_charge_voltage_control(int prot, int target_volt)
{
    int ret;
    int current_volt;
    
    // 1. 获取当前输出电压
    ret = adapter_get_output_voltage(prot, &current_volt);
    if (ret) {
        hwlog_err("get voltage fail\n");
        return ret;
    }
    
    hwlog_info("current voltage: %dmV, target: %dmV\n", 
               current_volt, target_volt);
    
    // 2. 计算电压差
    int delta = target_volt - current_volt;
    
    // 3. 分步调节（避免电压突变）
    int step = 200;  // 每步200mV
    while (abs(delta) > step) {
        int next_volt = current_volt + (delta > 0 ? step : -step);
        
        ret = adapter_set_output_voltage(prot, next_volt);
        if (ret) {
            hwlog_err("set voltage to %d fail\n", next_volt);
            return ret;
        }
        
        msleep(50);  // 等待稳定
        
        adapter_get_output_voltage(prot, &current_volt);
        delta = target_volt - current_volt;
    }
    
    // 4. 最终调节到目标电压
    return adapter_set_output_voltage(prot, target_volt);
}
```

### 4.5 温度保护
```c
int adapter_thermal_monitor(int prot)
{
    int ret;
    int inside_temp, port_temp;
    
    // 1. 读取充电器内部温度
    ret = adapter_get_inside_temp(prot, &inside_temp);
    if (ret) {
        hwlog_err("get inside temp fail\n");
        return ret;
    }
    
    // 2. 读取接口温度
    ret = adapter_get_port_temp(prot, &port_temp);
    if (ret) {
        hwlog_err("get port temp fail\n");
        return ret;
    }
    
    hwlog_info("adapter temp: inside=%d°C, port=%d°C\n", 
               inside_temp, port_temp);
    
    // 3. 温度保护逻辑
    if (inside_temp > 80) {
        hwlog_err("inside temp too high, stop charging\n");
        adapter_set_output_enable(prot, 0);  // 禁用输出
        return -EPERM;
    }
    
    if (port_temp > 60) {
        hwlog_warn("port temp high, reduce current\n");
        int max_cur;
        adapter_get_max_current(prot, &max_cur);
        adapter_set_output_current(prot, max_cur * 80 / 100);  // 降至80%
    }
    
    return 0;
}
```

### 4.6 充电器模式更新
```c
void adapter_update_adapter_support_mode(int prot, unsigned int *mode)
{
    int ret;
    int adp_type = ADAPTER_TYPE_UNKNOWN;
    
    // 1. 获取充电器类型
    ret = adapter_get_adp_type(prot, &adp_type);
    if (ret) {
        hwlog_err("get adp type failed\n");
        return;
    }
    
    // 2. 查表更新支持模式
    // 示例：ADAPTER_TYPE_20V3P25A 强制使用SC模式
    static struct adapter_update_mode_data update_table[] = {
        { ADAPTER_TYPE_20V3P25A, ADAPTER_SUPPORT_SC },
    };
    
    for (i = 0; i < ARRAY_SIZE(update_table); i++) {
        if (adp_type == update_table[i].adp_type) {
            *mode = update_table[i].mode;
            hwlog_info("update mode to 0x%x for type %d\n", *mode, adp_type);
            return;
        }
    }
}
```

---

## 5. 典型使用场景

### 5.1 场景1：SCP直充启动流程
```c
// 在direct_charge_scp.c中
int scp_direct_charge_init(void)
{
    int ret;
    int mode = 0;
    int prot = ADAPTER_PROTOCOL_SCP;
    
    // 1. 软复位充电器
    ret = adapter_soft_reset_slave(prot);
    if (ret) {
        hwlog_err("reset adapter fail\n");
        return ret;
    }
    
    // 2. 检测支持模式
    ret = adapter_detect_adapter_support_mode(prot, &mode);
    if (ret || !(mode & ADAPTER_SUPPORT_SC)) {
        hwlog_err("adapter not support SC mode\n");
        return -EPERM;
    }
    
    // 3. 获取充电器信息
    ret = adapter_get_device_info(prot);
    adapter_show_device_info(prot);
    
    // 4. 获取功率能力
    int max_volt, max_cur;
    adapter_get_max_voltage(prot, &max_volt);
    adapter_get_max_current(prot, &max_cur);
    hwlog_info("adapter capability: %dmV %dmA\n", max_volt, max_cur);
    
    // 5. 设置初始电压（稍高于电池电压）
    int init_volt = 5000;  // 5V起始
    ret = adapter_set_output_voltage(prot, init_volt);
    if (ret) {
        hwlog_err("set init voltage fail\n");
        return ret;
    }
    
    // 6. 使能输出
    ret = adapter_set_output_enable(prot, 1);
    if (ret) {
        hwlog_err("enable output fail\n");
        return ret;
    }
    
    hwlog_info("SCP direct charge init success\n");
    return 0;
}
```

### 5.2 场景2：UFCS协议功率协商
```c
// UFCS协议特有的功率曲线协商
int ufcs_power_negotiation(void)
{
    int ret;
    int prot = ADAPTER_PROTOCOL_UFCS;
    int num = 0;
    struct adp_pwr_curve_para curves[10];
    int size = 0;
    
    // 1. 获取功率曲线数量
    ret = adapter_get_power_curve_num(prot, &num);
    if (ret || num == 0) {
        hwlog_err("no power curve available\n");
        return -EPERM;
    }
    
    // 2. 获取功率曲线
    ret = adapter_get_power_curve(prot, curves, &size, 10);
    if (ret) {
        hwlog_err("get power curve fail\n");
        return ret;
    }
    
    // 3. 显示功率曲线
    hwlog_info("adapter support %d power curves:\n", size);
    for (i = 0; i < size; i++) {
        hwlog_info("  Curve %d: %dmV %dmA (%dW)\n", 
                   i, curves[i].volt, curves[i].cur,
                   curves[i].volt * curves[i].cur / 1000);
    }
    
    // 4. 选择最大功率点
    int max_power = 0;
    int selected_idx = 0;
    for (i = 0; i < size; i++) {
        int power = curves[i].volt * curves[i].cur;
        if (power > max_power) {
            max_power = power;
            selected_idx = i;
        }
    }
    
    // 5. 请求该功率点
    hwlog_info("request power: %dmV %dmA\n", 
               curves[selected_idx].volt, curves[selected_idx].cur);
    adapter_set_output_voltage(prot, curves[selected_idx].volt);
    adapter_set_output_current(prot, curves[selected_idx].cur);
    
    return 0;
}
```

### 5.3 场景3：PD协议电缆检测
```c
int pd_cable_capability_check(void)
{
    int ret;
    int prot = ADAPTER_PROTOCOL_PD;
    int cable_curr = 0;
    
    // 1. 获取电缆额定电流
    ret = adapter_get_cable_info(prot, &cable_curr);
    if (ret) {
        hwlog_err("get cable info fail\n");
        return ret;
    }
    
    hwlog_info("cable rated current: %dmA\n", cable_curr);
    
    // 2. 根据电缆能力限制充电电流
    int max_charge_curr = 6000;  // 期望6A充电
    
    if (cable_curr < max_charge_curr) {
        hwlog_warn("cable limit current to %dmA\n", cable_curr);
        max_charge_curr = cable_curr;
    }
    
    // 3. 设置充电电流
    adapter_set_output_current(prot, max_charge_curr);
    
    // 4. 检查端口泄漏电流
    int leak_flag = 0;
    ret = adapter_get_port_leakage_current_flag(prot, &leak_flag);
    if (!ret && leak_flag) {
        hwlog_err("port leakage detected, stop charging\n");
        adapter_set_output_enable(prot, 0);
        return -EPERM;
    }
    
    return 0;
}
```

### 5.4 场景4：充电器认证
```c
int adapter_authentication(int prot)
{
    int ret;
    int vendor_id = 0;
    int serial_num = 0;
    
    // 1. 读取厂商ID
    ret = adapter_get_chip_vendor_id(prot, &vendor_id);
    if (ret) {
        hwlog_err("get vendor id fail\n");
        return ret;
    }
    
    // 2. 读取序列号
    ret = adapter_get_chip_serial_num(prot, &serial_num);
    if (ret) {
        hwlog_err("get serial num fail\n");
        return ret;
    }
    
    hwlog_info("adapter: vendor=0x%x, serial=0x%x\n", vendor_id, serial_num);
    
    // 3. 验证是否华为官方充电器
    const int HUAWEI_VENDOR_ID = 0x12345678;  // 示例值
    if (vendor_id != HUAWEI_VENDOR_ID) {
        hwlog_warn("not official adapter, may limit power\n");
        // 限制为普通充电功率
        return -EPERM;
    }
    
    // 4. 启动加密认证（可选）
    if (prot == ADAPTER_PROTOCOL_SCP) {
        int auth_key = 0x5A5A;
        ret = adapter_auth_encrypt_start(prot, auth_key);
        if (ret) {
            hwlog_err("auth encrypt fail\n");
            return ret;
        }
        hwlog_info("adapter authenticated successfully\n");
    }
    
    return 0;
}
```

### 5.5 场景5：多协议切换
```c
int adapter_protocol_switch(void)
{
    int ret;
    int mode;
    
    // 1. 尝试UFCS协议（最新）
    ret = adapter_detect_adapter_support_mode(ADAPTER_PROTOCOL_UFCS, &mode);
    if (!ret && (mode & ADAPTER_SUPPORT_SC)) {
        hwlog_info("use UFCS protocol\n");
        return ufcs_charge_start();
    }
    
    // 2. 尝试SCP协议（华为快充）
    ret = adapter_detect_adapter_support_mode(ADAPTER_PROTOCOL_SCP, &mode);
    if (!ret && (mode & ADAPTER_SUPPORT_SC)) {
        hwlog_info("use SCP protocol\n");
        return scp_charge_start();
    }
    
    // 3. 尝试PD协议（通用）
    ret = adapter_detect_adapter_support_mode(ADAPTER_PROTOCOL_PD, &mode);
    if (!ret) {
        hwlog_info("use PD protocol\n");
        return pd_charge_start();
    }
    
    // 4. 降级到FCP（传统快充）
    ret = adapter_detect_adapter_support_mode(ADAPTER_PROTOCOL_FCP, &mode);
    if (!ret) {
        hwlog_info("use FCP protocol\n");
        return fcp_charge_start();
    }
    
    hwlog_err("no fast charge protocol supported\n");
    return -EPERM;
}
```

---

## 6. 调试方法

### 6.1 检查协议注册状态
```bash
# 查看内核日志
dmesg | grep "adapter_prot"
# 期望输出：
# [   10.123] adapter_prot: total_ops=1 type=0:hw_scp ops register ok
# [   10.234] adapter_prot: total_ops=2 type=1:hw_fcp ops register ok
# [   10.345] adapter_prot: total_ops=3 type=2:hw_pd ops register ok
# [   10.456] adapter_prot: total_ops=4 type=4:hw_ufcs ops register ok
```

### 6.2 测试充电器检测
```c
// 添加调试代码
void adapter_debug_detect_all_protocols(void)
{
    int mode;
    int prot;
    
    hwlog_info("=== Adapter Protocol Detection ===\n");
    
    for (prot = ADAPTER_PROTOCOL_BEGIN; prot < ADAPTER_PROTOCOL_END; prot++) {
        if (!adapter_detect_adapter_support_mode(prot, &mode)) {
            hwlog_info("Protocol %d: mode=0x%x\n", prot, mode);
            adapter_get_device_info(prot);
            adapter_show_device_info(prot);
        } else {
            hwlog_info("Protocol %d: not detected\n", prot);
        }
    }
}
```

### 6.3 常见问题排查

| 问题现象 | 可能原因 | 排查方法 |
|---------|---------|---------|
| `total_ops=0` | 协议驱动未加载 | 检查相关ko是否加载：`lsmod \| grep hw_scp` |
| 检测不到充电器 | 通信线路异常 | 检查D+/D-连接，测量电压 |
| 设置电压失败 | 超出充电器能力范围 | 先调用`get_max_voltage`查询范围 |
| 温度读取返回0 | 协议不支持温度查询 | 检查ops中是否实现`get_inside_temp` |
| 认证失败 | 非官方充电器 | 检查vendor_id是否匹配 |

### 6.4 日志分析示例
```bash
# 完整的充电器协商日志
dmesg | grep -E "adapter_prot|hw_scp"

# 典型输出：
# [  120.123] adapter_prot: detect_adapter_support_mode
# [  120.234] hw_scp: scp_adapter_detect enter
# [  120.345] hw_scp: scp protocol handshake success
# [  120.456] hw_scp: adapter_support_mode=0x6 (SC|SC4)
# [  120.567] adapter_prot: support_mode=0x6
# [  120.678] adapter_prot: vendor_id=0x12345678
# [  120.789] adapter_prot: max_volt=11000
# [  120.890] adapter_prot: max_cur=6000
# [  121.001] adapter_prot: adp_type=11 (11V6A)
```

---

## 7. 与其他模块的交互

### 7.1 依赖关系
```
adapter_protocol 模块依赖：
├── Linux标准库
│   ├── linux/module.h
│   └── linux/slab.h
└── power_printk.h  --> 日志打印

无其他电源模块依赖 → 纯协议框架
```

### 7.2 被依赖关系

| 模块 | 使用场景 | 典型调用 |
|-----|---------|---------|
| **direct_charge** | SCP/UFCS直充 | `adapter_set_output_voltage()` |
| **wireless_charge** | 无线充+有线充协同 | `adapter_get_device_info()` |
| **charge_pump** | 电荷泵配置 | `adapter_get_support_mode()` |
| **charger_core** | 充电器类型识别 | `adapter_detect_adapter_support_mode()` |

### 7.3 协议实现模块
```
adapter_protocol (框架层)
    ↓ 被以下模块注册ops
├── hw_scp.ko       → 注册ADAPTER_PROTOCOL_SCP
├── hw_fcp.ko       → 注册ADAPTER_PROTOCOL_FCP
├── hw_pd.ko        → 注册ADAPTER_PROTOCOL_PD
├── hw_uvdm.ko      → 注册ADAPTER_PROTOCOL_UVDM
└── hw_ufcs.ko      → 注册ADAPTER_PROTOCOL_UFCS
```

---

## 8. 性能优化与安全考虑

### 8.1 性能优化
```c
// 1. 缓存充电器信息，避免重复查询
static struct adapter_device_info g_cached_info;
static bool g_info_valid = false;

int adapter_get_cached_device_info(int prot)
{
    if (g_info_valid)
        return 0;
    
    int ret = adapter_get_device_info(prot);
    if (!ret)
        g_info_valid = true;
    
    return ret;
}

// 2. 批量读取，减少通信次数
int adapter_get_all_capability(int prot, struct adapter_cap *cap)
{
    adapter_get_min_voltage(prot, &cap->min_volt);
    adapter_get_max_voltage(prot, &cap->max_volt);
    adapter_get_min_current(prot, &cap->min_cur);
    adapter_get_max_current(prot, &cap->max_cur);
    // 一次通信完成所有读取
}
```

### 8.2 安全保护
```c
// 1. 电压范围检查
int adapter_safe_set_voltage(int prot, int volt)
{
    int min_volt, max_volt;
    
    adapter_get_min_voltage(prot, &min_volt);
    adapter_get_max_voltage(prot, &max_volt);
    
    if (volt < min_volt || volt > max_volt) {
        hwlog_err("voltage %d out of range [%d, %d]\n",
                  volt, min_volt, max_volt);
        return -EINVAL;
    }
    
    return adapter_set_output_voltage(prot, volt);
}

// 2. 温度保护
int adapter_safe_charge_monitor(int prot)
{
    int temp;
    
    if (!adapter_get_inside_temp(prot, &temp)) {
        if (temp > ADAPTER_TEMP_LIMIT) {
            hwlog_err("adapter overheat: %d°C\n", temp);
            adapter_set_output_enable(prot, 0);
            return -EPERM;
        }
    }
    
    return 0;
}
```

---

## 9. 总结

### 9.1 核心特性
| 特性 | 说明 |
|-----|------|
| **多协议统一** | 5种快充协议统一接口 |
| **47个标准接口** | 覆盖控制/查询/安全/认证 |
| **动态协议切换** | 自动选择最优协议 |
| **温度监控** | 充电器+接口双温度保护 |
| **功率协商** | 支持多档位功率曲线 |
| **电缆识别** | PD电缆能力检测 |
| **认证机制** | 厂商ID+序列号+加密 |

### 9.2 支持的充电器功率范围
```
充电器功率梯度：
├── 10W   - 5V2A (标准充电)
├── 18W   - 9V2A (快充入门)
├── 22.5W - 5V4.5A / 4.5V5A (FCP)
├── 40W   - 10V4A (SCP 1.0)
├── 66W   - 11V6A (SCP 2.0)
├── 88W   - 20V4.4A
├── 100W  - 20V5A (车载)
└── 134W  - 20V6.7A (嘉陵江旗舰)
```

### 9.3 模块价值总结
**adapter_protocol 作为快充协议抽象层**：
- 提供**统一的充电器操作接口**，屏蔽协议差异
- 支持**华为/行业标准多种协议**，兼容性强
- 实现**动态功率协商**，充分发挥充电器性能
- 内置**温度/电流/电缆多重保护**，保障安全
- 采用**ops回调机制**，易于扩展新协议
