# 华为充电管理系统架构
## 一、概述
本报告分析华为Mate X5（代号"charlotte"）的充电管理系统架构，该系统位于Linux内核的kernel/drivers/hwpower/目录下，是一个高度模块化、基于事件驱动和投票机制的复杂电源管理系统。

## 二、整体架构
### 2.1 分层架构
华为充电管理系统架构设计：

简单：
```
  ┌─────────────────────────────────────┐
  │        用户空间接口层                │
  │  (sysfs、uevent、power_supply)      │
  ├─────────────────────────────────────┤
  │        业务逻辑管理层                │
  │  (charge_manager、battery_core)     │
  ├─────────────────────────────────────┤
  │        协议与算法层                  │
  │  (protocol、algorithm、vote)        │
  ├─────────────────────────────────────┤
  │        硬件抽象与驱动层              │
  │  (hardware_ic、channel、coul)       │
  └─────────────────────────────────────┘
```
复杂：
```
╔══════════════════════════════════════════════════════════════════════════════╗
║                          用户空间 (User Space)                                ║
║  ┌─────────────┬──────────────┬──────────────┬─────────────┬──────────────┐  ║
║  │ 充电应用    │ 电池UI       │ 系统设置     │ 电源管理    │ 认证服务     │  ║
║  │ (Charge App)│ (Battery UI) │ (Settings)   │ (PowerMgr)  │ (Power Genl) │  ║
║  └─────────────┴──────────────┴──────────────┴─────────────┴──────────────┘  ║
╚══════════════════════════════════════════════════════════════════════════════╝
                                     ↕ (sysfs/ioctl/netlink)
╔══════════════════════════════════════════════════════════════════════════════╗
║                         内核空间 (Kernel Space)                               ║
║                          drivers/hwpower/                                     ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                                ║
║  ┌────────────────────────────────────────────────────────────────────────┐  ║
║  │                    业务逻辑管理层                                       │  ║
║  │  ┌──────────────────────────────────────────────────────────────────┐  │  ║
║  │  │ cc_charger/ - 充电管理器 (Charge Manager)                        │  │  ║
║  │  │  ├─ charge_manager.c          [充电总控制器]                     │  │  ║
║  │  │  ├─ buck_charge/               [标准Buck充电: 5V/9V/12V]         │  │  ║
║  │  │  ├─ direct_charge/             [直充: SCP/FCP/PD/UFCS 40W-135W] │  │  ║
║  │  │  ├─ wireless_charge/           [无线充电: Qi/AFC/私有协议]       │  │  ║
║  │  │  └─ hvdcp_charge/              [高压充电]                        │  │  ║
║  │  └──────────────────────────────────────────────────────────────────┘  │  ║
║  └────────────────────────────────────────────────────────────────────────┘  ║
║                                     ↕                                          ║
║  ┌────────────────────────────────────────────────────────────────────────┐  ║
║  │                 协议层 (Protocol Layer)                                │  ║
║  │  ┌──────────────────────────────────────────────────────────────────┐  │  ║
║  │  │ cc_protocol/                                                      │  │  ║
║  │  │  ├─ adapter_protocol/          [适配器协议抽象]                  │  │  ║
║  │  │  │   ├─ adapter_protocol.c     [协议路由层]                      │  │  ║
║  │  │  │   ├─ adapter_protocol_scp/  [SCP: 25-135W, I2C/D+D-]          │  │  ║
║  │  │  │   ├─ adapter_protocol_fcp/  [FCP: 18-36W, D+D-]               │  │  ║
║  │  │  │   ├─ adapter_protocol_pd/   [PD: 15-240W, Type-C]             │  │  ║
║  │  │  │   ├─ adapter_protocol_ufcs/ [UFCS: 统一快充标准 CCSA]         │  │  ║
║  │  │  │   └─ adapter_protocol_uvdm/ [UVDM: 华为私有PD VDM]            │  │  ║
║  │  │  └─ wireless_protocol/         [无线充电协议]                    │  │  ║
║  │  └──────────────────────────────────────────────────────────────────┘  │  ║
║  └────────────────────────────────────────────────────────────────────────┘  ║
║                                     ↕                                          ║
║  ┌────────────────────────────────────────────────────────────────────────┐  ║
║  │              硬件抽象层 (Hardware Abstraction Layer)                   │  ║
║  │  ┌───────────────────────┬────────────────────┬────────────────────┐  │  ║
║  │  │ cc_hardware_ic/       │ cc_hardware_channel/│ cc_adapter/       │  │  ║
║  │  │ [硬件IC驱动]          │ [硬件通道]         │ [适配器检测]      │  │  ║
║  │  ├───────────────────────┼────────────────────┼────────────────────┤  │  ║
║  │  │ • charger_ic/         │ • charger_channel/ │ • adapter_detect.c│  │  ║
║  │  │   (充电IC驱动)        │   (充电器通道)     │ • adapter_sysfs.c │  │  ║
║  │  │ • protocol_ic/        │ • vbus_channel/    │ • adapter_test.c  │  │  ║
║  │  │   (协议IC: SCP芯片)   │   (VBUS通道)       │                    │  │  ║
║  │  │ • charge_pump/        │ • wired_channel_   │                    │  │  ║
║  │  │   (电荷泵: 2:1/4:1)   │   switch/          │                    │  │  ║
║  │  │ • switch_capacitor/   │   (有线通道切换)   │                    │  │  ║
║  │  │   (开关电容)          │ • power_sw/        │                    │  │  ║
║  │  │ • fuel_gauge/         │   (功率开关)       │                    │  │  ║
║  │  │   (库仑计芯片)        │ • dischg_boost/    │                    │  │  ║
║  │  │ • wireless_charge_ic/ │   (放电升压)       │                    │  │  ║
║  │  │   (无线充电IC)        │                    │                    │  │  ║
║  │  │ • buck_boost/         │                    │                    │  │  ║
║  │  │ • boost_5v/           │                    │                    │  │  ║
║  │  │ • load_switch/        │                    │                    │  │  ║
║  │  └───────────────────────┴────────────────────┴────────────────────┘  │  ║
║  └────────────────────────────────────────────────────────────────────────┘  ║
║                                     ↕                                          ║
║  ┌────────────────────────────────────────────────────────────────────────┐  ║
║  │              监控与保护层 (Monitor & Protection Layer)                 │  ║
║  │  ┌──────────────────────────────────────────────────────────────────┐  │  ║
║  │  │ cc_hardware_monitor/                                              │  │  ║
║  │  │  ├─ temp_control/              [温度控制]                        │  │  ║
║  │  │  ├─ uscp/                      [USB短路保护]                     │  │  ║
║  │  │  ├─ vbus_monitor/              [VBUS监控]                        │  │  ║
║  │  │  ├─ water_detect/              [进水检测]                        │  │  ║
║  │  │  ├─ water_check/               [进水检查]                        │  │  ║
║  │  │  ├─ btb_check/                 [Board-to-Board连接检查]         │  │  ║
║  │  │  ├─ lga_check/                 [LGA连接检查]                    │  │  ║
║  │  │  ├─ acr_detect/                [交流阻抗检测]                   │  │  ║
║  │  │  ├─ bat_heating/               [电池加热]                       │  │  ║
║  │  │  ├─ ffc_control/               [快速充电控制]                   │  │  ║
║  │  │  ├─ soc_control/               [SOC控制]                        │  │  ║
║  │  │  ├─ soc_decimal/               [SOC小数显示]                    │  │  ║
║  │  │  ├─ cpu_buck/                  [CPU Buck控制]                   │  │  ║
║  │  │  ├─ low_power/                 [低功耗模式]                     │  │  ║
║  │  │  ├─ ship_mode/                 [运输模式]                       │  │  ║
║  │  │  └─ smpl/                      [突然掉电重启保护]               │  │  ║
║  │  └──────────────────────────────────────────────────────────────────┘  │  ║
║  └────────────────────────────────────────────────────────────────────────┘  ║
║                                     ↕                                          ║
║  ┌────────────────────────────────────────────────────────────────────────┐  ║
║  │                  电池管理层 (Battery Management Layer)                 │  ║
║  │  ┌─────────────────────────┬──────────────────────────────────────┐   │  ║
║  │  │ cc_battery/             │ cc_coul/                             │   │  ║
║  │  │ [电池核心管理]          │ [库仑计/电量计量]                    │   │  ║
║  │  ├─────────────────────────┼──────────────────────────────────────┤   │  ║
║  │  │ • battery_core.c        │ • coul_interface.c                   │   │  ║
║  │  │   (电池核心)            │   (库仑计接口)                       │   │  ║
║  │  │ • battery_1s2p/         │ • coul_calibration.c                 │   │  ║
║  │  │   (1串2并电池)          │   (库仑计校准)                       │   │  ║
║  │  │ • battery_cccv/         │ • coul_nv_pool.c                     │   │  ║
║  │  │   (恒流恒压)            │   (NV数据池)                         │   │  ║
║  │  │ • battery_charge_       │ • coul_sysfs.c                       │   │  ║
║  │  │   balance/              │   (sysfs接口)                        │   │  ║
║  │  │   (充电均衡)            │                                      │   │  ║
║  │  │ • battery_fault/        │                                      │   │  ║
║  │  │   (电池故障)            │                                      │   │  ║
║  │  │ • battery_model/        │                                      │   │  ║
║  │  │   (电池建模)            │                                      │   │  ║
║  │  │ • battery_ocv/          │                                      │   │  ║
║  │  │   (开路电压)            │                                      │   │  ║
║  │  │ • battery_soh/          │                                      │   │  ║
║  │  │   (电池健康度)          │                                      │   │  ║
║  │  │ • battery_temp/         │                                      │   │  ║
║  │  │   (电池温度)            │                                      │   │  ║
║  │  │ • battery_type_identify/│                                      │   │  ║
║  │  │   (电池类型识别)        │                                      │   │  ║
║  │  │ • battery_ui_capacity/  │                                      │   │  ║
║  │  │   (UI电量显示)          │                                      │   │  ║
║  │  └─────────────────────────┴──────────────────────────────────────┘   │  ║
║  └────────────────────────────────────────────────────────────────────────┘  ║
║                                     ↕                                          ║
║  ┌────────────────────────────────────────────────────────────────────────┐  ║
║  │               基础服务层 (Infrastructure Layer)                        │  ║
║  │  ┌──────────────────────────────────────────────────────────────────┐  │  ║
║  │  │ cc_common_module/ - 公共模块                                      │  │  ║
║  │  │  ├─ power_event/               [事件通知机制: notifier chain]    │  │  ║
║  │  │  ├─ power_genl/                [Netlink通信: 用户态交互]         │  │  ║
║  │  │  ├─ power_sysfs/               [sysfs接口]                       │  │  ║
║  │  │  ├─ power_supply/              [电源子系统接口]                  │  │  ║
║  │  │  ├─ power_i2c/                 [I2C总线封装]                     │  │  ║
║  │  │  ├─ power_gpio/                [GPIO控制]                        │  │  ║
║  │  │  ├─ power_dts/                 [设备树解析]                      │  │  ║
║  │  │  ├─ power_printk/              [日志打印]                        │  │  ║
║  │  │  ├─ power_dsm/                 [设备状态监控]                    │  │  ║
║  │  │  ├─ power_bigdata/             [大数据上报]                      │  │  ║
║  │  │  ├─ power_algorithm/           [算法库]                          │  │  ║
║  │  │  ├─ power_calibration/         [校准服务]                        │  │  ║
║  │  │  ├─ power_vote/                [投票机制]                        │  │  ║
║  │  │  ├─ power_interface/           [接口抽象]                        │  │  ║
║  │  │  ├─ power_devices_info/        [设备信息]                        │  │  ║
║  │  │  ├─ power_temp/                [温度管理]                        │  │  ║
║  │  │  ├─ power_time/                [时间服务]                        │  │  ║
║  │  │  ├─ power_wakeup/              [唤醒锁]                          │  │  ║
║  │  │  ├─ power_ui/                  [UI交互]                          │  │  ║
║  │  │  ├─ power_icon/                [图标管理]                        │  │  ║
║  │  │  ├─ power_delay/               [延迟服务]                        │  │  ║
║  │  │  ├─ power_firmware/            [固件管理]                        │  │  ║
║  │  │  ├─ power_pinctrl/             [引脚控制]                        │  │  ║
║  │  │  ├─ power_pwm/                 [PWM控制]                         │  │  ║
║  │  │  ├─ power_ioctl/               [ioctl接口]                       │  │  ║
║  │  │  ├─ power_cmdline/             [命令行参数]                      │  │  ║
║  │  │  ├─ power_debug/               [调试工具]                        │  │  ║
║  │  │  ├─ power_test/                [测试框架]                        │  │  ║
║  │  │  └─ power_thermalzone/         [热区管理]                        │  │  ║
║  │  └──────────────────────────────────────────────────────────────────┘  │  ║
║  └────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                ║
║  ┌────────────────────────────────────────────────────────────────────────┐  ║
║  │                     配件与隔离层 (Accessory Layer)                     │  ║
║  │  ┌──────────────────────────────────────────────────────────────────┐  │  ║
║  │  │ cc_accessory/                 [充电配件]                          │  │  ║
║  │  │  └─ wireless_lightstrap/      [无线充电配件]                     │  │  ║
║  │  │ cc_isolation/                 [隔离保护]                          │  │  ║
║  │  └──────────────────────────────────────────────────────────────────┘  │  ║
║  └────────────────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════════════════╝
                                     ↕
╔══════════════════════════════════════════════════════════════════════════════╗
║                         硬件层 (Hardware Layer)                               ║
║  ┌────────────┬──────────────┬────────────┬──────────────┬──────────────┐   ║
║  │ USB Type-C │ 充电IC       │ 协议IC     │ 库仑计芯片   │ 电池组       │   ║
║  │ (PD PHY)   │ (Buck/CP/SC) │ (SCP/UFCS) │ (Fuel Gauge) │ (Battery)    │   ║
║  └────────────┴──────────────┴────────────┴──────────────┴──────────────┘   ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

## 2.2 目录结构
```
  hwpower/
  ├── cc_accessory/              # 配件管理（无线光带等）
  ├── cc_adapter/                # 适配器检测与管理
  ├── cc_battery/                # 电池管理核心
  │   ├── battery_core.c         # 电池核心逻辑
  │   ├── battery_1s2p/          # 1串2并电池管理
  │   ├── battery_cccv/          # CC/CV充电控制
  │   ├── battery_charge_balance/# 电荷平衡
  │   ├── battery_fault/         # 电池故障检测
  │   ├── battery_model/         # 电池模型管理
  │   ├── battery_ocv/           # 开路电压管理
  │   ├── battery_soh/           # 电池健康度
  │   ├── battery_temp/          # 温度管理
  │   ├── battery_type_identify/ # 电池类型识别
  │   └── battery_ui_capacity/   # UI电量显示
  ├── cc_charger/                # 充电器管理
  │   ├── charge_manager.c       # 充电管理器
  │   ├── buck_charge/           # Buck充电模式
  │   ├── direct_charge/         # 直充模式（SCP/LVC）
  │   ├── hvdcp_charge/          # HVDCP快充
  │   ├── wireless_charge/       # 无线充电
  │   └── common/                # 公共接口
  ├── cc_common_module/          # 公共模块
  │   ├── power_event/           # 事件管理
  │   ├── power_vote/            # 投票机制
  │   ├── power_algorithm/       # 算法库
  │   ├── power_supply/          # 电源供应接口
  │   └── ...                    # 其他公共模块
  ├── cc_coul/                   # 电量计管理
  ├── cc_hardware_channel/       # 硬件通道
  ├── cc_hardware_ic/            # 硬件IC驱动
  ├── cc_isolation/              # 隔离保护
  └── cc_protocol/               # 充电协议
```

## 三、核心组件分析
### 3.1 电池管理核心 (cc_battery)
battery_core：电池系统的核心控制器，负责：
- 电池状态监控（存在性、充电状态、健康度）
- 温度补偿与NTC校准
- 容量等级管理
- 多电池系统支持（主/辅电池）
关键子模块：
- battery_1s2p：1串2并电池拓扑管理
- battery_cccv：恒流恒压充电算法
- battery_charge_balance：串并联电池电荷平衡
- battery_model：电池模型与参数管理
- battery_soh：电池健康度计算与预测
### 3.2 充电器管理 (cc_charger)
charge_manager：充电系统的总调度器，负责：
- 充电模式选择（Buck、直充、无线）
- 充电状态机管理
- 协议协商与适配器识别
- 故障处理与安全保护
充电模式：
- Buck Charge：传统降压充电，支持普通充电器
- Direct Charge：直充模式，支持SCP/LVC快充
- HVDCP：高电压快充协议
- Wireless Charge：无线充电管理
### 3.3 公共模块 (cc_common_module)
power_event：事件驱动框架，定义了大量电源相关事件：
- 连接/断开事件（USB、无线、OTG）
- 充电状态事件（开始、停止、完成、故障）
- 温度与保护事件
- 协议协商事件
power_vote：投票决策机制，用于多客户端参数协商：
- FCC（满充容量）投票
- ICL（输入电流限制）投票
- 电压与温度阈值投票
  
## 四、通信机制
### 4.1 事件通知机制
系统采用Linux内核的notifier机制实现组件间通信：
```c
  // 事件类型定义（超过200种事件）
  enum power_event_ne_type {
    POWER_NE_USB_CONNECT,          // USB连接
    POWER_NE_USB_DISCONNECT,       // USB断开
    POWER_NE_CHARGING_START,       // 充电开始
    POWER_NE_CHARGING_STOP,        // 充电停止
    POWER_NE_DC_LVC_CHARGING,      // LVC直充
    POWER_NE_DC_SC_CHARGING,       // SC直充
    // ... 其他事件
  };

  // 事件通知接口
  int power_event_bnc_notify(unsigned int bnt_type,
                          unsigned int event_type,
                          void *data);
```
### 4.2 投票决策机制
系统采用客户端投票机制进行参数决策：
```c
// 投票客户端定义
enum vote_client_type {
  VOTE_CLIENT_THERMAL,      // 温控客户端
  VOTE_CLIENT_USER,         // 用户配置
  VOTE_CLIENT_JEITA,        // JEITA温度规范
  VOTE_CLIENT_BASP,         // 电池保护
  VOTE_CLIENT_DC,          // 直充模块
  VOTE_CLIENT_CABLE,        // 线缆检测
  VOTE_CLIENT_ADAPTER,      // 适配器能力
  // ... 其他客户端
};

// 投票表结构
struct vote_table {
  int type;                 // 投票类型
  const char *name;         // 客户端名称
  int value;                // 投票值
  bool enabled;             // 是否启用
};
```
### 4.3 硬件抽象接口
系统通过操作接口抽象硬件差异：
```c
// 电量计接口
struct coul_interface_ops {
  int (*is_coul_ready)(void *dev_data);
  int (*is_battery_exist)(void *dev_data);
  int (*get_battery_capacity)(void *dev_data);
  int (*get_battery_temperature)(void *dev_data);
  int (*get_battery_voltage)(void *dev_data);
  int (*get_battery_current)(void *dev_data);
  // ... 其他操作
};

// 充电IC接口
struct buck_charge_ic_ops {
  int (*set_charge_current)(void *dev_data, int value);
  int (*set_input_current)(void *dev_data, int value);
  int (*set_charge_voltage)(void *dev_data, int value);
  int (*set_terminal_current)(void *dev_data, int value);
  // ... 其他操作
};
```
## 五、组件联系图
![](./images/001.png)

## 六、工作流程
### 6.1 充电启动流程
```
适配器插入检测
↓
协议握手（PD/SCP/FCP/UFCS）
↓
充电模式选择（投票决策）
↓
参数配置（电流/电压/温度）
↓
充电状态监控
↓
故障检测与保护
```

### 6.2 事件处理流程
```
硬件中断触发（连接/断开/故障）
↓
驱动层事件生成
↓
事件系统分发
↓
订阅者处理
↓
状态更新与反馈
```
### 6.3 投票决策流程
```
客户端提出参数需求
↓
投票系统收集所有客户端意见
↓
根据优先级和规则进行决策
↓
应用最终参数到硬件
↓
监控效果并动态调整
```
## 七、关键技术特点
### 7.1 模块化设计
- 每个功能模块独立，便于维护和扩展
- 通过接口抽象硬件差异
- 支持热插拔和动态配置
### 7.2 事件驱动架构
- 异步事件处理，提高响应速度
- 松耦合设计，降低模块间依赖
- 支持事件订阅和广播
### 7.3 投票决策机制
- 多客户端参数协商
- 优先级和权重管理
- 动态调整和优化
### 7.4 安全保护体系
- 多层次故障检测
- 温度、电压、电流保护
- 软件硬件双重保护
## 八、总结
华为充电管理系统是一个高度复杂、模块化、事件驱动的电源管理架构，具有以下核心优势：
1. 分层架构：清晰的层次划分，便于理解和维护
2. 模块化设计：功能模块独立，支持灵活扩展
3. 事件驱动：异步处理，响应迅速
4. 投票决策：多客户端协商，优化参数配置
5. 安全可靠：多层次保护，确保充电安全