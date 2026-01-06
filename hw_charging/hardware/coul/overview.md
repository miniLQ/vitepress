---
outline: deep
---

# CC_COUL 库仑计公共层模块分析

## 1. 技术定位与架构设计

### 1.1 模块价值分析

CC_COUL 模块在华为 MATE X5 电源管理系统中扮演**中间抽象层**角色，解决了以下核心问题：

**问题域：**
- 多种库仑计硬件（PMIC、Scharger、智能电池）接口不统一
- 工厂校准数据需要持久化存储和运行时应用
- 双电池系统需要独立管理主辅库仑计
- 开发调试需要模拟电池参数

**解决方案：**
```
┌──────────────────────────────────────────┐
│  应用层统一调用入口                       │
│  coul_interface_get_battery_xxx(type)    │
└──────────────────────────────────────────┘
                   ↓
┌──────────────────────────────────────────┐
│  CC_COUL 公共层 (本模块)                  │
│  ┌──────────┬──────────┬──────────┐      │
│  │接口抽象  │校准管理  │参数池    │      │
│  │Interface │Calibrate │NV Pool   │      │
│  └──────────┴──────────┴──────────┘      │
│  ┌──────────┬──────────────────────┐     │
│  │Sysfs接口│测试调试 Test         │      │
│  └──────────┴──────────────────────┘     │
└──────────────────────────────────────────┘
                   ↓
┌──────────────────────────────────────────┐
│  硬件驱动层（动态注册）                   │
│  PMIC COUL / Scharger COUL / Smart Bat   │
└──────────────────────────────────────────┘
```

### 1.2 子模块职责划分

| 子模块 | 文件 | 核心职责 | 关键技术 |
|:-------:|:------:|:---------:|:---------:|
| **接口层** | coul_interface.c | 统一API封装，多实例管理 | 函数指针表、动态注册 |
| **校准层** | coul_calibration.c | 电流电压校准系数管理 | NV存储、cmdline解析 |
| **参数池** | coul_nv_pool.c | 电量状态持久化 | OCV索引、循环计数 |
| **用户接口** | coul_sysfs.c | 电量日志导出 | Power Supply集成 |
| **测试框架** | coul_test.c | 参数模拟注入 | debugfs覆盖 |

---

## 2. 接口抽象层深度解析

### 2.1 多库仑计支持策略

华为 MATE X5 采用双电池架构，需要同时管理多个库仑计实例：

**类型定义与映射：**

|设备类型           |字符串标识      |典型应用场景|
|:---:|:----:|:-----:|
|COUL_TYPE_MAIN    |"main"         |主电池（串联电池组第一块）|
|COUL_TYPE_AUX     |"aux"          |辅电池（串联电池组第二块）|
|COUL_TYPE_1S2P    |"1s2p"         |1串2并电池（折叠屏展开场景）|


**实例管理机制：**
- 全局设备表 `g_coul_interface_dev->p_ops[COUL_TYPE_END]`
- 每个类型仅允许一个驱动实例注册
- 通过字符串匹配实现类型识别

### 2.2 关键查询接口工作流

**电池电量获取流程：**
```
coul_interface_get_battery_capacity(type)
    ↓
[1] 检查测试模式是否启用
    ├─ YES → 返回 coul_test 注入的模拟值
    └─ NO  → 继续下一步
    ↓
[2] 获取对应类型的 ops 函数表
    ↓
[3] 调用 ops->get_battery_capacity(dev_data)
    ↓
[4] 硬件驱动层计算 SOC 并返回
```

**测试模式优先级设计意图：**
- 开发阶段可模拟各种电量状态（0%、50%、100%）
- 无需真实改变电池电量即可测试充电逻辑
- 通过 debugfs 节点动态控制

### 2.3 完整接口清单

**状态查询类（17个）：**
```c
// 基础状态
is_coul_ready()              // 库仑计是否就绪
is_battery_exist()           // 电池是否在位
is_smart_battery()           // 是否智能电池
get_coul_model()             // 库仑计型号

// 电量信息
get_battery_capacity()       // SOC百分比（0-100）
get_battery_rm()             // 剩余容量 Remaining (mAh)
get_battery_fcc()            // 满充容量 Full Charge Capacity
get_battery_last_capacity()  // 上次记录的SOC
get_battery_charge_counter() // 充电计数器（uAh累计）

// 电气参数
get_battery_voltage()        // 电池电压 (mV)
get_battery_current()        // 瞬时电流 (mA)
get_battery_avg_current()    // 平均电流 (mA)

// 环境参数
get_battery_temperature()    // 电池温度 (0.1°C)
get_battery_cycle()          // 循环次数

// 充电建议
get_desired_charging_current()  // 期望充电电流
get_desired_charging_voltage()  // 期望充电电压
```

**配置控制类（3个）：**
```c
set_battery_last_capacity()     // 保存SOC（关机记忆）
set_vterm_dec()                  // 截止电压补偿
set_battery_low_voltage()        // 低电压阈值
```

---

## 3. 校准系统设计与实现

### 3.1 校准原理

库仑计通过电流积分计算电量，但硬件 ADC 存在系统误差，需要校准：

**线性校准模型：**
```
实际值 = ADC原始值 × 增益(A) + 偏移(B)

电流校准：I_real = I_adc × CUR_A + CUR_B
电压校准：V_real = V_adc × VOL_A + VOL_B
```

**校准参数存储：**
```c
// 二维数组：[模式][参数]
g_coul_cali_data[COUL_CALI_MODE_MAIN][COUL_CALI_PARA_CUR_A]  // 主库仑计电流增益
g_coul_cali_data[COUL_CALI_MODE_MAIN][COUL_CALI_PARA_CUR_B]  // 主库仑计电流偏移
g_coul_cali_data[COUL_CALI_MODE_MAIN][COUL_CALI_PARA_VOL_A]  // 主库仑计电压增益
g_coul_cali_data[COUL_CALI_MODE_MAIN][COUL_CALI_PARA_VOL_B]  // 主库仑计电压偏移
g_coul_cali_data[COUL_CALI_MODE_AUX][...]                    // 辅库仑计参数
```

### 3.2 校准数据来源

**启动时加载（cmdline）：**
```bash
# bootloader 传递校准参数到内核
cmdline: fg_cali=0x3FF,0x00,0x400,0x00,0x3FE,0x01,0x3FF,0x00
                 ^^^^^ ^^^^^ ^^^^^ ^^^^^ 主库仑计参数
                                         ^^^^^ ^^^^^ ^^^^^ ^^^^^ 辅库仑计参数
```

**运行时写入（NV存储）：**
```c
// 工厂校准工具调用
coul_cali_set_data(COUL_CALI_PARA_CUR_A, 0x3FF, dev_data);
coul_cali_save_data(dev_data);  // 写入 POWER_NV_CUROFFSET 分区
```

### 3.3 校准模式控制

**进入校准模式：**
```bash
# 禁用正常库仑计算法，使能原始ADC读取
echo 8 > /sys/kernel/debug/power_cali/coul/mode
```

**执行校准流程：**
```
1. 进入校准模式 (mode=8)
    ↓
2. 施加标准电流（如 1000mA 恒流源）
    ↓
3. 读取原始 ADC 值 (get_data offset=4)
    ↓
4. 计算校准系数
    A = 标准值 / ADC值
    B = 0（假设无偏移）
    ↓
5. 写入校准参数 (set_data offset=0,1,2,3)
    ↓
6. 保存到 NV (save_data)
    ↓
7. 退出校准模式 (mode=9)
```

---

## 4. NV 参数池机制

### 4.1 参数池设计目标

电池状态信息需要跨重启保存，NV Pool 管理以下关键参数：

| 参数 | 说明 | 更新时机 | 恢复策略 |
|-----|------|---------|---------|
| **BK_BATTERY_CURR_CALI** | 备份电流校准 | 工厂校准后 | 优先使用 cmdline |
| **OCV_INDEX** | OCV表索引 | SOC变化时 | 开机快速定位SOC |
| **TEMP_CYCLE** | 临时循环计数 | 每次充放电循环 | 异常断电检测 |
| **TOTAL_CYCLE** | 总循环计数 | TEMP_CYCLE溢出时 | 累加历史循环 |

### 4.2 循环次数管理算法

**正常流程：**
```c
// 库仑计 IC 内部维护 TEMP_CYCLE（易失）
ic_cycle = 50;  // 当前已完成 50 次循环

// 定期同步到 NV
coul_nv_pool_set_para(COUL_NV_POOL_IC_TYPE_MAIN, 
                      COUL_NV_POOL_TEMP_CYCLE, 
                      ic_cycle);
// NV: TEMP_CYCLE=50, TOTAL_CYCLE=0
```

**异常断电恢复：**
```c
// 重启后读取 NV
nv_temp_cycle = 50;   // NV中的值
ic_cycle = 0;         // IC复位为0

// 检测到异常（nv_temp_cycle > ic_cycle）
if (nv_temp_cycle > ic_cycle) {
    TOTAL_CYCLE += TEMP_CYCLE;  // TOTAL_CYCLE = 0 + 50 = 50
    TEMP_CYCLE = ic_cycle;       // TEMP_CYCLE = 0
}

// 真实循环次数 = TEMP_CYCLE + TOTAL_CYCLE
```

### 4.3 电池更换检测

**场景：** 维修更换电池后，循环次数应清零

**实现机制：**
```c
// 启动 3 秒后检查电池 SN
queue_delayed_work(system_power_efficient_wq, &di->once_work, 3000);

static void coul_nv_pool_once_work(struct work_struct *work)
{
    // 调用电池信息模块检查 SN 是否改变
    if (check_battery_sn_changed()) {
        // 清零循环计数
        coul_nv_pool_set_para(COUL_NV_POOL_IC_TYPE_MAIN, 
                              COUL_NV_POOL_TEMP_CYCLE, 0);
        coul_nv_pool_set_para(COUL_NV_POOL_IC_TYPE_MAIN, 
                              COUL_NV_POOL_TOTAL_CYCLE, 0);
        hwlog_info("new battery! cycle in nv pool is cleared\n");
    }
}
```

---

## 5. Sysfs 用户接口

### 5.1 导出节点

**路径：** `/sys/class/hw_power/coul/coul_data/`

**节点功能：**
```bash
# gaugelog_head - 日志表头
cat gaugelog_head
# 输出: brand       ocv       

# gaugelog - 当前电量状态
cat gaugelog
# 输出: DESAY       3950      
#       ^^^^^ 电池品牌
#                   ^^^^ OCV电压(mV)
```

### 5.2 集成 Power Supply 框架

**实现要点：**
```c
// 通过 power_supply 获取电池信息
power_supply_get_str_property_value(psy_name, 
    POWER_SUPPLY_PROP_BRAND, &bat_brand);

power_supply_get_int_property_value(psy_name, 
    POWER_SUPPLY_PROP_VOLTAGE_NOW, &bat_ocv);
```

**可配置电源名称（DTS）：**
```
coul_sysfs {
    compatible = "huawei,fuelguage";
    psy_name = "battery";  // 默认 "battery"，可配置为 "main_battery"
};
```

---

## 6. 测试框架应用

### 6.1 测试模式使能

**场景：** 模拟低电量告警（SOC=5%）测试关机流程

**操作步骤：**
```bash
# 1. 设置测试标志（位掩码）
#    COUL_TEST_BAT_CAPACITY = 0x02
echo 2 > /sys/kernel/debug/hw_power/coul_test/flag

# 2. 设置模拟电量
echo 5 > /sys/kernel/debug/hw_power/coul_test/bat_capacity

# 3. 验证生效
cat /sys/class/power_supply/battery/capacity
# 输出: 5

# 4. 关闭测试模式
echo 0 > /sys/kernel/debug/hw_power/coul_test/flag
```

### 6.2 支持的测试参数

| 节点 | 功能 | 位掩码 | 默认值 |
|-----|------|-------|-------|
| **flag** | 测试模式控制 | - | 0（关闭） |
| **bat_exist** | 电池在位状态 | 0x01 | - |
| **bat_capacity** | SOC百分比 | 0x02 | - |
| **bat_temp** | 电池温度(0.1°C) | 0x04 | - |
| **bat_cycle** | 循环次数 | 0x08 | - |

**组合测试示例：**
```bash
# 同时模拟低电量 + 高温
echo 6 > flag              # 0x02 | 0x04 = 0x06
echo 10 > bat_capacity     # 10%
echo 550 > bat_temp        # 55°C
```

---

## 7. 典型应用场景

### 7.1 双电池系统集成

**硬件拓扑：**
```
主电池（3.8V 5000mAh） ←→ 主库仑计（PMIC COUL）
    串联
辅电池（3.8V 5000mAh） ←→ 辅库仑计（Scharger COUL）
    ↓
总电压 7.6V，总容量 5000mAh
```

**驱动注册流程：**
```c
// 主库仑计驱动注册
struct coul_interface_ops main_coul_ops = {
    .type_name = "main",
    .get_battery_capacity = main_coul_get_capacity,
    ...
};
coul_interface_ops_register(&main_coul_ops);

// 辅库仑计驱动注册
struct coul_interface_ops aux_coul_ops = {
    .type_name = "aux",
    .get_battery_capacity = aux_coul_get_capacity,
    ...
};
coul_interface_ops_register(&aux_coul_ops);
```

**上层调用：**
```c
// 获取主电池电量
main_soc = coul_interface_get_battery_capacity(COUL_TYPE_MAIN);

// 获取辅电池电量
aux_soc = coul_interface_get_battery_capacity(COUL_TYPE_AUX);

// 计算总电量（取较低值）
total_soc = min(main_soc, aux_soc);
```

### 7.2 工厂校准完整流程

**设备：** 标准电流源、高精度万用表

**步骤：**
```
1. 设备上电，进入 fastboot 模式
2. 传递初始校准参数（cmdline）
    ↓
3. 进入 Android 系统
4. 执行校准脚本：
    # 进入校准模式
    echo 0 > /sys/kernel/debug/power_cali/coul/mode  # 选择主库仑计
    echo 8 > /sys/kernel/debug/power_cali/coul/mode  # 进入校准
    
    # 电流校准
    施加 1000mA 标准电流
    实测 ADC = cat /sys/kernel/debug/power_cali/coul/data?offset=4
    计算 CUR_A = 1000 / 实测值
    echo $CUR_A > /sys/kernel/debug/power_cali/coul/data?offset=0
    
    # 电压校准
    施加 4000mV 标准电压
    实测 ADC = cat /sys/kernel/debug/power_cali/coul/data?offset=5
    计算 VOL_A = 4000 / 实测值
    echo $VOL_A > /sys/kernel/debug/power_cali/coul/data?offset=2
    
    # 保存并退出
    echo 1 > /sys/kernel/debug/power_cali/coul/save_data
    echo 9 > /sys/kernel/debug/power_cali/coul/mode
5. 写入 NV 分区（持久化）
6. 重启验证精度
```

---

## 8. 技术要点总结

### 8.1 设计模式应用

- **策略模式**：通过函数指针表实现不同库仑计驱动的动态切换
- **单例模式**：全局设备指针 `g_coul_xxx_dev` 保证唯一实例
- **外观模式**：统一接口封装隐藏底层复杂性

### 8.2 关键技术

- **cmdline 解析**：`early_param` 机制在内核早期加载校准参数
- **NV 持久化**：`power_nv_write` 与 `power_nv_read` 接口访问非易失存储
- **延迟工作队列**：`delayed_work` 实现电池 SN 延迟检测
- **调试覆盖**：测试框架通过优先级判断覆盖真实数据

### 8.3 维护注意事项

1. **多库仑计互斥**：同一类型仅允许一个驱动注册
2. **NV 读写保护**：防止频繁写入损坏 Flash
3. **测试模式隔离**：生产版本应禁用 `CONFIG_HUAWEI_POWER_DEBUG`
4. **校准参数范围**：增益 A 通常在 0.9-1.1 之间，偏移 B 在 ±50 范围
