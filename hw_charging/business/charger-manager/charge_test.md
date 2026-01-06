---
outline: deep
---
# 华为充电管理之Charge Mode Test 模块

## 1. 模块概述

### 1.1 模块定位
Charge Mode Test 是华为充电系统中的**自动化测试模块**，用于对各种充电模式进行系统化的功能验证和性能测试。该模块可以自动切换不同的充电协议和充电模式，并验证充电电流是否达到预期阈值。

**核心功能：**
- 多种充电模式自动化测试（DCP/LVC/SC/SC4/HVC）
- 多协议支持（UFCS/SCP/FCP）
- 充电电流阈值验证
- 测试结果自动记录与上报
- 异常状态检测（温度异常、电压异常、CC潮湿等）

**文件位置：**
```
drivers/hwpower/cc_charger/test/
├── charge_mode_test.c      # 测试模块核心实现
├── charge_mode_test.h      # 数据结构与接口定义
└── Makefile                # 编译配置
```

### 1.2 设计特点

**自动化测试流程：**
- 配置驱动测试：通过 DTS 配置测试参数（协议、模式、电流阈值、测试时间）
- 顺序测试执行：按照配置顺序自动切换充电模式
- 实时监控：通过定时任务（5秒周期）监控充电状态
- 结果记录：自动记录每个模式的测试结果（成功/失败/失败原因）

**灵活配置：**
- 支持多达 50 种充电模式组合测试
- 支持跳过不支持的适配器模式
- 支持强制测试模式（force）和提前结束模式（ext）
- 支持自定义启动延迟时间

---

## 2. 核心数据结构

### 2.1 充电模式参数结构

```c
struct charge_mode_para {
    char protocol[PROTOCOL_LEN_MAX];         // 充电协议：ufcs/scp/fcp
    char mode[CHARGE_MODE_LEN_MAX];          // 充电模式：dcp/lvc/sc/sc4/hvc等
    int ibat_th;                              // 电池充电电流阈值 (mA)
    int time;                                 // 测试超时时间 (ms)
    int ext;                                  // 提前结束标志（1=成功即结束）
    int force;                                // 强制测试标志（1=忽略适配器能力）
    enum charge_mode_result result;           // 测试结果：INIT/SUCC/FAIL
    enum charge_mode_sub_result sub_result;   // 详细子结果
};
```

**参数说明：**
- `protocol`：适配器协议类型（"ufcs", "scp", "fcp"）
- `mode`：充电模式（"dcp", "lvc", "sc", "sc_main", "sc_aux", "sc4", "sc4_main", "sc4_aux", "hvc"）
- `ibat_th`：电流阈值，测试时需达到此电流才算成功
- `time`：测试超时时间（秒），转换为毫秒后存储
- `ext`：提前结束标志（1=达到电流阈值即结束，0=必须持续到超时）
- `force`：强制测试（1=即使适配器不支持也测试，0=适配器不支持则跳过）

### 2.2 测试设备结构

```c
struct charge_mode_dev {
    struct device *dev;                                    // 设备指针
    struct notifier_block charge_mode_nb;                  // 事件通知块
    struct delayed_work test_work;                         // 延迟工作队列
    struct charge_mode_para mode_para[CHARGE_MODE_NUM_MAX]; // 测试参数数组（最多50组）
    long long start_time;                                  // 当前模式测试开始时间
    long long curr_time;                                   // 当前时间
    int mode_idx;                                          // 当前测试模式索引
    int mode_num;                                          // 总测试模式数量
    int adp_mode;                                          // 适配器支持的模式掩码
    int ping_result;                                       // PING 检测结果
    int temp_err_flag;                                     // 温度错误标志
    int voltage_invalid_flag;                              // 电压无效标志
    int delay_time;                                        // 启动延迟时间
    char result[RESULT_BUF_LEN_MAX];                       // 结果缓冲区
};
```

### 2.3 测试结果枚举

```c
/* 主测试结果 */
enum charge_mode_result {
    CHARGE_MODE_RESULT_INIT = 0,    // 初始状态/测试中
    CHARGE_MODE_RESULT_SUCC,        // 测试成功
    CHARGE_MODE_RESULT_FAIL,        // 测试失败
};

/* 详细子结果 */
enum charge_mode_sub_result {
    CHARGE_MODE_SUB_INIT = 0,        // 初始状态
    CHARGE_MODE_SUB_SUCC,            // 成功完成
    CHARGE_MODE_IBAT_FAIL,           // 充电电流未达阈值
    CHARGE_MODE_UE_PROTOCOL_FAIL,    // UE端协议不支持
    CHARGE_MODE_ADP_PROTOCOL_FAIL,   // 适配器协议不支持
    CHARGE_MODE_CC_MOISTURE,         // CC 引脚潮湿
    CHARGE_MODE_TEMP_ERR,            // 温度异常
    CHARGE_MODE_VOL_INVALID,         // 电压异常
    CHARGE_MODE_ADP_UNSUPPORT,       // 适配器不支持该模式
};
```

### 2.4 充电模式类型枚举

```c
enum charge_mode_type {
    CHARGE_MODE_TYPE_DCP = 0,       // 标准 DCP 充电（5V）
    CHARGE_MODE_TYPE_LVC,           // 低压直充（1:1）
    CHARGE_MODE_TYPE_SC,            // 开关电容直充（2:1）
    CHARGE_MODE_TYPE_MAIN_SC,       // 主路 SC
    CHARGE_MODE_TYPE_AUX_SC,        // 辅路 SC
    CHARGE_MODE_TYPE_SC4,           // 4:1 开关电容
    CHARGE_MODE_TYPE_MAIN_SC4,      // 主路 SC4
    CHARGE_MODE_TYPE_AUX_SC4,       // 辅路 SC4
    CHARGE_MODE_TYPE_HVC,           // 高压充电（HVDCP）
    CHARGE_MODE_TYPE_END,
};
```

### 2.5 协议映射表

```c
/* 协议名称到索引的映射 */
static struct charge_mode_map g_protocol_tbl[] = {
    { "ufcs", CHARGE_MODE_PROTOCOL_UFCS },
    { "scp",  CHARGE_MODE_PROTOCOL_SCP },
    { "fcp",  CHARGE_MODE_PROTOCOL_HVC }
};

/* 模式名称到索引的映射 */
static struct charge_mode_map g_mode_tbl[] = {
    { "dcp",      CHARGE_MODE_TYPE_DCP },
    { "lvc",      CHARGE_MODE_TYPE_LVC },
    { "sc",       CHARGE_MODE_TYPE_SC },
    { "sc_main",  CHARGE_MODE_TYPE_MAIN_SC },
    { "sc_aux",   CHARGE_MODE_TYPE_AUX_SC },
    { "sc4",      CHARGE_MODE_TYPE_SC4 },
    { "sc4_main", CHARGE_MODE_TYPE_MAIN_SC4 },
    { "sc4_aux",  CHARGE_MODE_TYPE_AUX_SC4 },
    { "hvc",      CHARGE_MODE_TYPE_HVC },
};

/* 模式到适配器能力掩码的映射 */
static int g_adp_mode_map[] = {
    ADAPTER_SUPPORT_UNDEFINED,     // DCP
    ADAPTER_SUPPORT_LVC,           // LVC
    ADAPTER_SUPPORT_SC,            // SC
    ADAPTER_SUPPORT_SC,            // MAIN_SC
    ADAPTER_SUPPORT_SC,            // AUX_SC
    ADAPTER_SUPPORT_SC4,           // SC4
    ADAPTER_SUPPORT_SC4,           // MAIN_SC4
    ADAPTER_SUPPORT_SC4,           // AUX_SC4
    ADAPTER_SUPPORT_HV,            // HVC
};
```

### 2.6 模式控制动作表

```c
/* 模式使能控制动作表 */
static struct charge_mode_action g_action_tbl[] = {
    { POWER_IF_OP_TYPE_DCP,     INVALID_INDEX },              // DCP
    { POWER_IF_OP_TYPE_LVC,     INVALID_INDEX },              // LVC
    { POWER_IF_OP_TYPE_SC,      INVALID_INDEX },              // SC
    { POWER_IF_OP_TYPE_MAINSC,  POWER_IF_OP_TYPE_SC },        // MAIN_SC（需先使能SC）
    { POWER_IF_OP_TYPE_AUXSC,   POWER_IF_OP_TYPE_SC },        // AUX_SC（需先使能SC）
    { POWER_IF_OP_TYPE_SC4,     INVALID_INDEX },              // SC4
    { POWER_IF_OP_TYPE_MAINSC4, POWER_IF_OP_TYPE_SC4 },       // MAIN_SC4（需先使能SC4）
    { POWER_IF_OP_TYPE_AUXSC4,  POWER_IF_OP_TYPE_SC4 },       // AUX_SC4（需先使能SC4）
    { POWER_IF_OP_TYPE_HVC,     INVALID_INDEX },              // HVC
};
```

---

## 3. 核心功能实现

### 3.1 协议选择

```c
static int charge_mode_select_protocol(struct charge_mode_dev *di)
{
    unsigned int prot_type;
    unsigned int init_prot;
    int adp_mode;
    int index;

    for (adp_mode = 0; di->mode_idx < di->mode_num; di->mode_idx++) {
        /* 获取模式索引 */
        index = charge_mode_get_map_index(di->mode_para[di->mode_idx].mode, 
                                          g_mode_tbl, ARRAY_SIZE(g_mode_tbl));
        
        /* HVC 模式无需协议切换 */
        if (index == CHARGE_MODE_TYPE_HVC)
            return CHARGE_MODE_SUCCESS;

        /* 获取协议索引 */
        index = charge_mode_get_map_index(di->mode_para[di->mode_idx].protocol, 
                                          g_protocol_tbl, ARRAY_SIZE(g_protocol_tbl));
        if (index == INVALID_INDEX)
            continue;

        /* 如果协议与上一个模式相同，跳过协议切换 */
        if ((di->mode_idx > 0) &&
            (strcmp(di->mode_para[di->mode_idx].protocol, 
                    di->mode_para[di->mode_idx - 1].protocol) == 0))
            return CHARGE_MODE_SUCCESS;

        /* 检查协议是否支持 */
        prot_type = adapter_detect_get_sysfs_protocol_type(index);
        init_prot = adapter_detect_get_init_protocol_type();
        
        if ((prot_type & init_prot) || (init_prot == 0)) {
            /* 设置协议 */
            power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_ADAPTER_PROTOCOL, 
                                      POWER_IF_SYSFS_ADAPTER_PROTOCOL, index);
            hwlog_info("select protocol %s\n", di->mode_para[di->mode_idx].protocol);

            /* 延迟 1 秒等待协议切换完成 */
            (void)power_msleep(DT_MSLEEP_1S, 0, NULL);
            return CHARGE_MODE_SUCCESS;
        } else {
            /* 协议不支持 */
            charge_mode_set_result(&di->mode_para[di->mode_idx], 
                                   CHARGE_MODE_RESULT_FAIL, 
                                   CHARGE_MODE_UE_PROTOCOL_FAIL);
            hwlog_err("not support protocol %s\n", 
                      di->mode_para[di->mode_idx].protocol);
        }
    }

    hwlog_err("protocol select fail\n");
    return CHARGE_MODE_FAILURE;
}
```

**协议选择逻辑：**
1. 检查模式是否为 HVC（HVC 不需要协议切换）
2. 检查协议是否与上一个模式相同（避免重复切换）
3. 验证协议是否被系统支持
4. 通过 sysfs 接口设置协议
5. 延迟 1 秒等待协议切换完成

### 3.2 模式选择与使能

```c
static void charge_mode_select_mode(char *mode)
{
    int index;

    hwlog_info("select mode %s\n", mode);

    /* 获取模式索引 */
    index = charge_mode_get_map_index(mode, g_mode_tbl, ARRAY_SIZE(g_mode_tbl));

    /* 步骤1：禁用所有充电模式 */
    power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_ALL, 
                              POWER_IF_SYSFS_ENABLE_CHARGER, DISABLE);
    
    /* 等待 2 秒，确保所有模式停止 */
    (void)power_msleep(DT_MSLEEP_2S, 0, NULL);
    
    /* 步骤2：使能 DCP 基础充电 */
    power_if_kernel_sysfs_set(POWER_IF_OP_TYPE_DCP, 
                              POWER_IF_SYSFS_ENABLE_CHARGER, ENABLE);
    
    /* 步骤3：使能目标充电模式（第一级） */
    power_if_kernel_sysfs_set(g_action_tbl[index].first, 
                              POWER_IF_SYSFS_ENABLE_CHARGER, ENABLE);

    /* 步骤4：如果有第二级使能，延迟后使能 */
    if (g_action_tbl[index].second != INVALID_INDEX) {
        (void)power_msleep(DT_MSLEEP_1S, 0, NULL);
        power_if_kernel_sysfs_set(g_action_tbl[index].second, 
                                  POWER_IF_SYSFS_ENABLE_CHARGER, ENABLE);
    }
}
```

**模式切换流程：**
```
禁用所有充电模式
    ↓
等待 2 秒（确保直充完全停止）
    ↓
使能 DCP 基础充电
    ↓
使能目标充电模式（第一级）
    ↓
如需第二级使能（如 MAIN_SC）
    ↓
延迟 1 秒后使能第二级
```

**二级使能示例：**
- `sc_main`：先使能 SC，1秒后使能 MAIN_SC
- `sc_aux`：先使能 SC，1秒后使能 AUX_SC
- `sc4_main`：先使能 SC4，1秒后使能 MAIN_SC4

### 3.3 充电电流计算与判断

```c
static bool charge_mode_caculate(struct charge_mode_dev *di)
{
    int ibat = 0;
    int ibat_th;
    int index;

    if (di->mode_idx == INVALID_INDEX)
        return false;

    /* 获取电流阈值 */
    ibat_th = di->mode_para[di->mode_idx].ibat_th;
    
    /* 获取模式索引 */
    index = charge_mode_get_map_index(di->mode_para[di->mode_idx].mode, 
                                      g_mode_tbl, ARRAY_SIZE(g_mode_tbl));
    
    /* HVC 模式特殊处理 */
    if ((index == CHARGE_MODE_TYPE_HVC) && 
        (hvdcp_get_charging_stage() == HVDCP_STAGE_SUCCESS))
        return hvdcp_check_running_current(ibat_th);

    /* 直充模式：获取电池充电电流 */
    if (direct_charge_get_stage_status() == DC_STAGE_CHARGING)
        direct_charge_get_bat_current(&ibat);

    hwlog_info("ibat = %d ibat_th = %d\n", ibat, ibat_th);

    /* 判断电流是否达到阈值 */
    if (ibat >= ibat_th)
        return true;

    return false;
}
```

**电流判断逻辑：**
- **HVC 模式**：调用 `hvdcp_check_running_current()` 检查
- **直充模式**：从 Direct Charge 模块获取电池电流
- **判断标准**：实际电流 >= 配置的电流阈值

### 3.4 测试结果更新

```c
static void charge_mode_update_result(struct charge_mode_dev *di)
{
    int index;

    if (di->mode_idx == INVALID_INDEX)
        return;

    index = charge_mode_get_map_index(di->mode_para[di->mode_idx].mode, 
                                      g_mode_tbl, ARRAY_SIZE(g_mode_tbl));

    /* 检查异常状态（CC潮湿、温度异常、电压异常） */
    if (charge_mode_valid(di) == CHARGE_MODE_SUCCESS) {
        di->mode_para[di->mode_idx].result = CHARGE_MODE_RESULT_SUCC;
        di->temp_err_flag = false;
        di->voltage_invalid_flag = false;
        return;
    }

    /* 提前结束模式：达到电流阈值即成功 */
    if ((di->mode_para[di->mode_idx].result == CHARGE_MODE_RESULT_SUCC) &&
        (di->mode_para[di->mode_idx].ext == ENABLE)) {
        di->mode_para[di->mode_idx].sub_result = CHARGE_MODE_SUB_SUCC;
        hwlog_info("end the mode test in advance\n");
        return;
    }

    /* 超时判断 */
    if (di->curr_time - di->start_time >= di->mode_para[di->mode_idx].time) {
        hwlog_info("this mode test timeout\n");
        
        /* 从未达到电流阈值 -> 失败 */
        if (di->mode_para[di->mode_idx].result == CHARGE_MODE_RESULT_INIT)
            charge_mode_set_result(&di->mode_para[di->mode_idx], 
                                   CHARGE_MODE_RESULT_FAIL, 
                                   CHARGE_MODE_IBAT_FAIL);
        
        /* 曾经达到过电流阈值 -> 成功 */
        if (di->mode_para[di->mode_idx].result == CHARGE_MODE_RESULT_SUCC)
            di->mode_para[di->mode_idx].sub_result = CHARGE_MODE_SUB_SUCC;
        return;
    }

    /* HVC 模式测试中 */
    if (index == CHARGE_MODE_TYPE_HVC) {
        hwlog_info("hvc test\n");
        return;
    }

    /* 适配器协议 PING 失败 */
    if (di->ping_result == CHARGE_MODE_FAILURE) {
        charge_mode_set_result(&di->mode_para[di->mode_idx], 
                               CHARGE_MODE_RESULT_FAIL, 
                               CHARGE_MODE_ADP_PROTOCOL_FAIL);
        di->ping_result = CHARGE_MODE_SUCCESS;
        hwlog_info("adapter not support protocol %s\n", 
                   di->mode_para[di->mode_idx].protocol);
        return;
    }

    /* 适配器不支持该模式（且未强制测试） */
    if ((di->adp_mode != 0 && (di->adp_mode & g_adp_mode_map[index]) == 0) &&
        (di->mode_para[di->mode_idx].force == DISABLE)) {
        charge_mode_set_result(&di->mode_para[di->mode_idx], 
                               CHARGE_MODE_RESULT_SUCC, 
                               CHARGE_MODE_ADP_UNSUPPORT);
        hwlog_err("adapter not support mode %s\n", 
                  di->mode_para[di->mode_idx].mode);
    }
}
```

**结果更新流程：**
```
检查异常状态（CC潮湿/温度/电压）
    ↓
检查提前结束条件（ext=1 且已达阈值）
    ↓
检查超时条件
    ├─> 从未达阈值 -> FAIL (IBAT_FAIL)
    └─> 曾达阈值 -> SUCC (SUB_SUCC)
    ↓
检查协议 PING 失败
    ↓
检查适配器能力不支持
```

### 3.5 测试监控任务

```c
static void charge_mode_monitor(struct work_struct *work)
{
    struct charge_mode_dev *di = NULL;
    di = container_of(work, struct charge_mode_dev, test_work.work);

    /* 更新当前时间 */
    di->curr_time = ktime_to_ms(ktime_get_boottime());

    /* 计算充电电流是否达标 */
    if (charge_mode_caculate(di))
        di->mode_para[di->mode_idx].result = CHARGE_MODE_RESULT_SUCC;
    else
        charge_mode_set_result(&di->mode_para[di->mode_idx], 
                               CHARGE_MODE_RESULT_INIT, 
                               CHARGE_MODE_SUB_INIT);

    /* 更新测试结果 */
    charge_mode_update_result(di);

    /* 判断是否跳到下一个模式 */
    if (charge_mode_jump_mode(di)) {
        di->mode_idx++;
        di->adp_mode = 0;
        di->ping_result = 0;
        
        /* 所有模式测试完成 */
        if (di->mode_idx >= di->mode_num) {
            charge_mode_state_reset(di);
            return;
        }

        /* 选择下一个模式的协议 */
        if (charge_mode_select_protocol(di)) {
            charge_mode_state_reset(di);
            return;
        }

        /* 选择并使能下一个充电模式 */
        charge_mode_select_mode(di->mode_para[di->mode_idx].mode);

        /* 记录开始时间 */
        di->start_time = ktime_to_ms(ktime_get_boottime());
    }

    /* 调度下一次监控（5秒后） */
    schedule_delayed_work(&di->test_work, msecs_to_jiffies(CHARGE_MODE_WORK_TIME));
}
```

**监控任务流程：**
```
更新当前时间
    ↓
检查充电电流是否达标
    ├─> 达标 -> 标记 SUCC
    └─> 未达标 -> 保持 INIT
    ↓
更新测试结果（超时/异常判断）
    ↓
判断是否跳转下一个模式
    ├─> 不跳转 -> 继续监控当前模式
    └─> 跳转
        ↓
    mode_idx++
        ↓
    选择下一个协议
        ↓
    使能下一个模式
        ↓
    记录开始时间
    ↓
调度下一次监控（5秒后）
```

### 3.6 事件通知处理

```c
static int charge_mode_notifier_call(struct notifier_block *nb,
    unsigned long event, void *data)
{
    struct charge_mode_dev *di = NULL;
    di = container_of(nb, struct charge_mode_dev, charge_mode_nb);

    if (!di)
        return NOTIFY_OK;

    switch (event) {
    case POWER_NE_DC_PING_FAIL:
        /* 直充 PING 失败 */
        di->ping_result = CHARGE_MODE_FAILURE;
        break;
        
    case POWER_NE_DC_ADAPTER_MODE:
        /* 适配器能力上报 */
        di->adp_mode = *((int *)data);
        break;
        
    case POWER_NE_DC_TEMP_ERR:
        /* 温度异常 */
        di->temp_err_flag = true;
        break;
        
    case POWER_NE_DC_VOLTAGE_INVALID:
        /* 电压异常 */
        di->voltage_invalid_flag = true;
        break;
        
    case POWER_NE_DC_CHECK_SUCC:
        /* 检查成功，清除异常标志 */
        di->temp_err_flag = false;
        di->voltage_invalid_flag = false;
        break;
        
    default:
        break;
    }

    return NOTIFY_OK;
}
```

**监听事件：**
- `POWER_NE_DC_PING_FAIL`：直充 PING 失败
- `POWER_NE_DC_ADAPTER_MODE`：适配器能力上报
- `POWER_NE_DC_TEMP_ERR`：温度异常
- `POWER_NE_DC_VOLTAGE_INVALID`：电压异常
- `POWER_NE_DC_CHECK_SUCC`：检查成功

---

## 4. Sysfs 接口

### 4.1 接口定义

```c
static struct power_sysfs_attr_info charge_mode_sysfs_field_tbl[] = {
    power_sysfs_attr_wo(charge_mode, 0200, CHARGE_MODE_SYSFS_START, start),
    power_sysfs_attr_ro(charge_mode, 0440, CHARGE_MODE_SYSFS_RESULT, result),
};
```

### 4.2 Sysfs 节点

**路径：** `/sys/class/hw_power/charger/charge_mode_tst/`

#### 节点1：start（只写）
**功能：** 启动充电模式测试

**用法：**
```bash
# 启动测试
echo 1 > /sys/class/hw_power/charger/charge_mode_tst/start
```

**内部处理：**
```c
static void charge_mode_start(struct charge_mode_dev *di)
{
    /* 初始化所有测试结果 */
    charge_mode_set_all_result(di, CHARGE_MODE_RESULT_INIT, CHARGE_MODE_SUB_INIT);
    
    /* 初始化测试参数 */
    charge_mode_init_para(di);

    /* 如果配置了延迟时间，先延迟 */
    if (di->delay_time)
        power_msleep(di->delay_time, 0, NULL);
    
    hwlog_info("charge mode test start\n");

    /* 取消之前的测试任务 */
    cancel_delayed_work_sync(&di->test_work);
    
    /* 立即启动测试任务 */
    schedule_delayed_work(&di->test_work, 0);
}
```

#### 节点2：result（只读）
**功能：** 获取测试结果

**用法：**
```bash
# 查看测试结果
cat /sys/class/hw_power/charger/charge_mode_tst/result
```

**输出格式：**
```
protocol1,mode1,result1,sub_result1;protocol2,mode2,result2,sub_result2;...
```

**示例输出：**
```
scp,lvc,2,1;scp,sc,2,1;scp,sc4,1,3;ufcs,lvc,2,1;ufcs,sc,2,1;
```

**字段说明：**
- `protocol`：充电协议（scp/ufcs/fcp）
- `mode`：充电模式（lvc/sc/sc4/hvc等）
- `result`：主结果（0=INIT, 1=SUCC, 2=FAIL）
- `sub_result`：详细结果（见枚举定义）

**内部处理：**
```c
static int charge_mode_result(struct charge_mode_dev *di, char *buf)
{
    int i, k, ret;

    k = 0;
    for (i = 0; i < di->mode_num; i++) {
        ret = sprintf_s(buf + k, PAGE_SIZE, "%s,%s,%d,%d;",
            di->mode_para[i].protocol, 
            di->mode_para[i].mode, 
            di->mode_para[i].result, 
            di->mode_para[i].sub_result);
        if (ret == INVALID_RESULT)
            return CHARGE_MODE_FAILURE;

        k += ret;
    }
    return k;
}
```

### 4.3 调试节点

**路径：** `/sys/kernel/debug/hw_power/charge_mode_tst/delay`

**功能：** 设置测试启动延迟时间

**用法：**
```bash
# 设置延迟时间为 5000ms
echo 5000 > /sys/kernel/debug/hw_power/charge_mode_tst/delay

# 查看当前延迟时间
cat /sys/kernel/debug/hw_power/charge_mode_tst/delay
```

---

## 5. DTS 配置

### 5.1 配置示例

```
charge_mode_test {
    compatible = "huawei,charge_mode_test";
    status = "ok";
    
    test_para = 
        /* protocol, mode,   ibat_th, time, ext, force */
        "scp",     "lvc",   "3000",  "60",  "0", "0",
        "scp",     "sc",    "5000",  "60",  "0", "0",
        "scp",     "sc4",   "8000",  "60",  "0", "0",
        "ufcs",    "lvc",   "3000",  "60",  "0", "0",
        "ufcs",    "sc",    "5000",  "60",  "0", "0",
        "ufcs",    "sc4",   "8000",  "60",  "0", "0",
        "fcp",     "hvc",   "2000",  "60",  "0", "0";
};
```

### 5.2 参数说明

| 参数 | 类型 | 说明 | 示例 |
|-----|------|------|------|
| protocol | string | 充电协议 | "scp"/"ufcs"/"fcp" |
| mode | string | 充电模式 | "lvc"/"sc"/"sc4"/"hvc" |
| ibat_th | int | 电流阈值（mA） | "3000" = 3A |
| time | int | 测试时间（秒） | "60" = 60秒 |
| ext | int | 提前结束标志 | "1"=达标即结束, "0"=持续到超时 |
| force | int | 强制测试标志 | "1"=忽略适配器能力, "0"=适配器不支持则跳过 |

### 5.3 解析逻辑

```c
static void charge_mode_parse_dts(struct device_node *np, struct charge_mode_dev *di)
{
    int i, row, col, array_len, ret;
    const char *tmp_string = NULL;

    /* 读取测试参数数组 */
    array_len = power_dts_read_count_strings(power_dts_tag(HWLOG_TAG), np,
        "test_para", CHARGE_MODE_NUM_MAX, CHARGE_MODE_PARA_TOTAL);
    if (array_len < 0)
        return;

    /* 逐个解析参数 */
    for (i = 0; i < array_len; i++) {
        if (power_dts_read_string_index(power_dts_tag(HWLOG_TAG),
            np, "test_para", i, &tmp_string))
            continue;

        /* 计算行列索引 */
        row = i / CHARGE_MODE_PARA_TOTAL;  // 第几个测试项
        col = i % CHARGE_MODE_PARA_TOTAL;  // 第几个参数

        /* 调用对应的解析函数 */
        ret = g_parse_tbl[col](di, row, tmp_string, (col - CHARGE_MODE_IBAT_TH));
        if (ret)
            return;

        /* 时间参数需转换为毫秒 */
        if (col == CHARGE_MODE_TIME)
            di->mode_para[row].time *= MSEC_PER_SEC;
    }
}
```

---

## 6. 典型使用场景

### 6.1 标准测试流程

```bash
# 1. 配置 DTS 测试参数（编译时配置）
# 2. 插入快充适配器
# 3. 启动测试
echo 1 > /sys/class/hw_power/charger/charge_mode_tst/start

# 4. 等待测试完成（根据配置的时间总和）
# 5. 查看测试结果
cat /sys/class/hw_power/charger/charge_mode_tst/result

# 输出示例：
# scp,lvc,2,1;scp,sc,2,1;scp,sc4,1,3;ufcs,lvc,2,1;
```

### 6.2 测试场景示例

#### 场景1：全协议全模式测试
```
test_para = 
    "scp",  "lvc",  "3000", "60", "0", "0",
    "scp",  "sc",   "5000", "60", "0", "0",
    "scp",  "sc4",  "8000", "60", "0", "0",
    "ufcs", "lvc",  "3000", "60", "0", "0",
    "ufcs", "sc",   "5000", "60", "0", "0",
    "ufcs", "sc4",  "8000", "60", "0", "0",
    "fcp",  "hvc",  "2000", "60", "0", "0";
```

**测试顺序：**
1. SCP + LVC（3A，60秒）
2. SCP + SC（5A，60秒）
3. SCP + SC4（8A，60秒）
4. UFCS + LVC（3A，60秒）
5. UFCS + SC（5A，60秒）
6. UFCS + SC4（8A，60秒）
7. FCP + HVC（2A，60秒）

#### 场景2：快速验证（提前结束模式）
```
test_para = 
    "scp", "lvc", "3000", "60", "1", "0",  // ext=1，达标即结束
    "scp", "sc",  "5000", "60", "1", "0";
```

**说明：** 一旦充电电流达到阈值，立即结束当前模式测试，进入下一个模式

#### 场景3：强制测试（忽略适配器能力）
```
test_para = 
    "scp", "sc4", "8000", "60", "0", "1";  // force=1，强制测试
```

**说明：** 即使适配器不支持 SC4，也会尝试测试（用于调试）

#### 场景4：主辅路单独测试
```
test_para = 
    "scp", "sc_main", "3000", "60", "0", "0",  // 主路 SC
    "scp", "sc_aux",  "2000", "60", "0", "0";  // 辅路 SC
```

### 6.3 测试结果解读

#### 成功示例
```
scp,lvc,2,1;
```
- 协议：SCP
- 模式：LVC
- 结果：2（SUCC）
- 详细结果：1（SUB_SUCC）
- **解读**：LVC 模式测试成功，充电电流达到阈值

#### 失败示例1：电流不达标
```
scp,sc,1,3;
```
- 协议：SCP
- 模式：SC
- 结果：1（FAIL）
- 详细结果：3（IBAT_FAIL）
- **解读**：SC 模式测试失败，超时仍未达到电流阈值

#### 失败示例2：适配器不支持
```
ufcs,sc4,2,8;
```
- 协议：UFCS
- 模式：SC4
- 结果：2（SUCC）
- 详细结果：8（ADP_UNSUPPORT）
- **解读**：适配器不支持 SC4 模式，跳过测试（标记为成功）

#### 失败示例3：协议不支持
```
ufcs,lvc,1,4;
```
- 协议：UFCS
- 模式：LVC
- 结果：1（FAIL）
- 详细结果：4（ADP_PROTOCOL_FAIL）
- **解读**：适配器不支持 UFCS 协议

---

## 7. 调试方法

### 7.1 日志分析

**日志标签：** `charge_mode_tst`

**关键日志输出：**
```bash
# 测试启动
[charge_mode_tst] charge mode test start

# 协议选择
[charge_mode_tst] select protocol scp

# 模式选择
[charge_mode_tst] select mode lvc

# 电流检测
[charge_mode_tst] ibat = 3200 ibat_th = 3000

# 提前结束
[charge_mode_tst] end the mode test in advance

# 超时
[charge_mode_tst] this mode test timeout

# 适配器不支持
[charge_mode_tst] adapter not support mode sc4

# 协议不支持
[charge_mode_tst] not support protocol ufcs
```

### 7.2 常见问题诊断

#### 问题1：测试无法启动
```bash
# 检查模块是否加载
lsmod | grep charge_mode_test

# 检查 sysfs 节点是否存在
ls /sys/class/hw_power/charger/charge_mode_tst/

# 检查 DTS 配置
cat /proc/device-tree/charge_mode_test/status
```

#### 问题2：所有模式测试失败
```bash
# 检查充电器是否插入
cat /sys/class/power_supply/usb/present

# 检查充电器类型
cat /sys/class/power_supply/usb/type

# 检查 Vbus 电压
cat /sys/class/power_supply/usb/voltage_now

# 查看 dmesg 日志
dmesg | grep charge_mode_tst
```

#### 问题3：部分模式跳过（ADP_UNSUPPORT）
```bash
# 查看适配器能力
cat /sys/class/hw_power/adapter/adapter_support_mode

# 示例输出（十六进制掩码）
# 0x16 = 0b10110 -> 支持 LVC(0x2) + SC(0x4) + HV(0x10)
```

**适配器能力掩码：**
- `0x01`：UNDEFINED
- `0x02`：LVC
- `0x04`：SC
- `0x08`：SC4
- `0x10`：HV（HVDCP）

#### 问题4：电流不达标（IBAT_FAIL）
```bash
# 实时监控充电电流
watch -n 1 cat /sys/class/power_supply/battery/current_now

# 检查直充状态
cat /sys/class/hw_power/direct_charger/charge_stage

# 检查温度限制
cat /sys/class/power_supply/battery/temp

# 检查电压限制
cat /sys/class/power_supply/battery/voltage_now
```

### 7.3 手动控制测试

```bash
# 1. 设置延迟时间（可选）
echo 5000 > /sys/kernel/debug/hw_power/charge_mode_tst/delay

# 2. 启动测试
echo 1 > /sys/class/hw_power/charger/charge_mode_tst/start

# 3. 实时监控日志
logcat -s charge_mode_tst

# 4. 等待测试完成后查看结果
cat /sys/class/hw_power/charger/charge_mode_tst/result

# 5. 解析结果（使用脚本）
cat /sys/class/hw_power/charger/charge_mode_tst/result | \
  awk -F';' '{for(i=1;i<=NF;i++) print $i}'
```

---

## 8. 关键技术要点

### 8.1 测试自动化

**顺序执行机制：**
- 通过 `mode_idx` 索引顺序遍历测试项
- 每个模式测试完成后自动切换到下一个
- 支持协议复用（连续相同协议的模式无需重新切换）

**时间管理：**
- 使用 `ktime_get_boottime()` 获取启动时间（不受休眠影响）
- 每个模式独立计时（`start_time` 和 `curr_time`）
- 5秒监控周期（`CHARGE_MODE_WORK_TIME`）

### 8.2 结果判定逻辑

```
电流达标判断：
    ↓
    YES → 标记 RESULT_SUCC
    NO  → 保持 RESULT_INIT
    ↓
超时判断：
    ↓
    从未达标 → FAIL (IBAT_FAIL)
    曾经达标 → SUCC (SUB_SUCC)
    ↓
异常检测：
    ↓
    CC潮湿 → SUCC (CC_MOISTURE)
    温度异常 → SUCC (TEMP_ERR)
    电压异常 → SUCC (VOL_INVALID)
    ↓
适配器能力检测：
    ↓
    协议不支持 → FAIL (ADP_PROTOCOL_FAIL/UE_PROTOCOL_FAIL)
    模式不支持 → SUCC (ADP_UNSUPPORT)
```

### 8.3 与其他模块的交互

```
charge_mode_test 依赖模块：
├── direct_charger         # 获取直充状态和电池电流
├── hvdcp_charge           # HVC 模式电流验证
├── adapter_detect         # 协议类型和适配器能力
├── power_interface        # sysfs 接口控制充电模式
└── power_event            # 事件通知（PING失败、适配器能力等）

事件订阅：
└── POWER_BNT_DC
    ├── POWER_NE_DC_PING_FAIL         # PING 失败
    ├── POWER_NE_DC_ADAPTER_MODE      # 适配器能力
    ├── POWER_NE_DC_TEMP_ERR          # 温度异常
    ├── POWER_NE_DC_VOLTAGE_INVALID   # 电压异常
    └── POWER_NE_DC_CHECK_SUCC        # 检查成功
```

### 8.4 工作队列机制

```c
/* 延迟工作队列定义 */
struct delayed_work test_work;

/* 初始化 */
INIT_DELAYED_WORK(&di->test_work, charge_mode_monitor);

/* 启动测试（立即执行） */
schedule_delayed_work(&di->test_work, 0);

/* 周期调度（5秒后） */
schedule_delayed_work(&di->test_work, msecs_to_jiffies(CHARGE_MODE_WORK_TIME));

/* 取消任务 */
cancel_delayed_work_sync(&di->test_work);
```

---

## 9. 总结

### 9.1 模块特点

1. **自动化程度高**：配置后一键启动，自动完成全流程测试
2. **灵活配置**：支持多种协议、模式、参数组合
3. **结果详细**：不仅记录成功/失败，还记录详细失败原因
4. **智能跳过**：自动识别适配器能力，跳过不支持的模式
5. **异常检测**：实时监测 CC 潮湿、温度、电压等异常

### 9.2 适用场景

- **研发测试**：新适配器兼容性验证
- **生产测试**：出厂快充功能测试
- **故障诊断**：充电问题定位分析
- **性能评估**：充电电流性能评估

### 9.3 注意事项

1. **测试时间**：总测试时间 = Σ(每个模式的time) + 协议切换时间
2. **适配器要求**：需使用支持多协议的快充适配器
3. **电池状态**：建议电池电量 < 80% 以保证充电电流
4. **温度控制**：避免温度过高触发保护
5. **并发限制**：测试期间禁用其他充电控制操作
