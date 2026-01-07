---
outline: deep
---

# FFC Control 模块分析

## 一、模块概述

### 1.1 功能定位
**FFC Control (Fast Full Charge Control)** 是华为 MATE X5 充电系统中的**快充满电控制模块**，主要负责在快充或直充（Direct Charge）场景下**动态调整充电截止电压（Vterm）和截止电流（Iterm）**，以实现更高的电池充电容量和更优的充电安全策略。

### 1.2 核心功能
- **动态电压提升**：根据温度和充电状态动态增加充电截止电压（Vterm Gain）
- **多温度区间适配**：支持 0-8 个温度区间的差异化充电参数配置
- **多电池适配**：支持石墨电池（Graphite）和硅基电池（Silicon）的差异化策略
- **充电场景识别**：识别 DC 直充、FCP 快充等场景并应用对应策略
- **安全控制**：通过电流阈值和电压降策略保障充电安全

### 1.3 设计背景
在快充（FCP）或超级快充（SCP/Direct Charge）场景下，为了提高充电容量（达到更接近电池额定容量），需要在满足安全条件下动态提升充电截止电压。传统固定 Vterm 无法充分利用电池容量，FFC Control 通过温度感知、电流监控等机制实现智能化的 Vterm/Iterm 调整。

---

## 二、系统架构

### 2.1 模块组成
```
ffc_control 模块
├── ffc_control.c       # 主控制逻辑（事件处理、状态管理）
├── ffc_base.c          # 基础算法（参数选择、DTS 解析）
├── ffc_control.h       # 对外接口定义
└── ffc_base.h          # 内部数据结构定义
```

### 2.2 架构分层
```
+-----------------------------------------------------------+
|                  Charger Framework                         |
|  (charge_core.c 调用 ffc_ctrl_get_incr_vterm())           |
+-----------------------------------------------------------+
                            ↑
                            | ffc_ctrl_get_incr_vterm()
                            | ffc_ctrl_notify_ffc_info()
+-----------------------------------------------------------+
|              ffc_control.c (状态机与事件处理)               |
|   - 监听充电事件 (CHARGING_STOP, DC_CHECK_START, FCP)      |
|   - 管理 FFC 状态标志 (ffc_vterm_flag)                     |
|   - 控制延迟计数器 (ffc_delay_cnt)                         |
+-----------------------------------------------------------+
                            ↑
                            | ffc_get_buck_vterm_with_temp()
                            | ffc_get_buck_vterm()
                            | ffc_get_buck_iterm()
+-----------------------------------------------------------+
|               ffc_base.c (参数计算引擎)                    |
|   - 根据温度选择充电参数                                    |
|   - 电池型号匹配（石墨/硅基）                                |
|   - DTS 参数解析                                           |
+-----------------------------------------------------------+
                            ↑
                            | DTS 配置
+-----------------------------------------------------------+
|                   Device Tree                              |
|   - buck_term_para: 默认温度分段参数                       |
|   - ffc_bat_para: 多电池型号参数组                         |
+-----------------------------------------------------------+
```

### 2.3 关键数据流
1. **充电启动阶段**：
   - DC/FCP 检测事件 → 设置 `dc_adp`/`fcp_adp` 标志
   - Charger Framework 调用 `ffc_ctrl_get_incr_vterm()` 查询电压增量

2. **充电执行阶段**：
   - 根据温度查表获取 `vterm_gain`（电压增量）
   - 检查电流条件（ichg_avg vs ichg_thre）决定是否继续提升电压
   - 延迟计数器机制避免频繁切换

3. **充电停止阶段**：
   - CHARGING_STOP 事件 → 清零所有状态标志
   - 恢复默认 Vterm/Iterm 配置

---

## 三、核心数据结构

### 3.1 充电参数结构
```c
struct ffc_buck_term_para {
    int temp_low;       // 温度下限（单位：0.1°C）
    int temp_high;      // 温度上限
    int vterm_gain;     // 电压增量（mV），如 50mV
    int ichg_thre;      // 电流阈值（mA），如 800mA
    int iterm;          // 截止电流（mA），如 160mA
};
```

**配置示例**：
```dts
buck_term_para = <
    /* temp_low, temp_high, vterm_gain, ichg_thre, iterm */
    0   100   0    0    160    /* 0-10°C: 无增益 */
    100 200   30   800  180    /* 10-20°C: +30mV, 阈值800mA */
    200 450   50   1000 200    /* 20-45°C: +50mV, 阈值1000mA */
>;
```

### 3.2 设备管理结构
```c
struct ffc_ctrl_dev {
    struct device *dev;
    struct notifier_block event_nb;          // 充电事件通知器
    struct notifier_block event_dc_nb;       // DC 事件通知器
    struct notifier_block event_fcp_nb;      // FCP 事件通知器
    
    // 参数配置
    struct ffc_buck_term_para buck_term_para[FFC_MAX_CHARGE_TERM];
    struct ffc_term_para_group *ffc_term_para_group;  // 多电池参数组
    int group_size;
    
    // 运行状态
    u32 ffc_vterm_flag;     // FFC 状态标志（BIT0: 开始, BIT1: 结束）
    int ffc_delay_cnt;      // 延迟计数器
    int delay_max_times;    // 最大延迟次数（默认 2 次）
    
    // 适配器识别
    bool dc_adp;            // DC 适配器连接标志
    bool fcp_adp;           // FCP 适配器连接标志
    bool fcp_support_ffc;   // FCP 是否支持 FFC
    
    // 电池识别
    bool term_para_select_ok;  // 参数选择完成标志
    int bat_type;              // 电池类型（BATTERY_C/BATTERY_SI）
};
```

### 3.3 充电信息通知结构
```c
struct ffc_ctrl_charge_info {
    bool ffc_charge_flag;   // 是否处于 FFC 充电模式
    bool dc_mode;           // 是否处于 DC 直充模式
    int iterm;              // 当前截止电流（mA）
};
```

---

## 四、核心算法与工作流程

### 4.1 电压增量计算逻辑（ffc_ctrl_get_incr_vterm）

```c
int ffc_ctrl_get_incr_vterm(void)
{
    // 1. 检查是否需要进入 FFC（DC 或支持的 FCP）
    if (!ffc_ctrl_need_enter_ffc(di))
        return 0;
    
    // 2. DC 充电阶段：返回带温度补偿的电压增量
    if (direct_charge_in_charging_stage() == DC_IN_CHARGING_STAGE)
        return ffc_get_buck_vterm_with_temp(di);
    
    // 3. DC 转 BUCK 阶段检查
    if (!direct_charge_check_charge_done())
        return 0;  // 未完成 DC 充电，不启动 FFC
    
    // 4. 延迟阶段（避免频繁切换）
    if (di->ffc_delay_cnt < di->delay_max_times) {
        ffc_vterm = ffc_get_buck_vterm_with_temp(di);
        di->ffc_delay_cnt++;
    } else {
        // 5. 正式 FFC 阶段：根据电流条件判断
        ffc_vterm = ffc_get_buck_vterm(di);
    }
    
    // 6. FFC 结束处理
    if (di->ffc_vterm_flag & FFC_VETRM_END_FLAG) {
        charge_update_iterm(ffc_get_buck_iterm(di));
        return 0;
    }
    
    // 7. 退出条件检测
    if (ffc_vterm == 0 && (di->ffc_vterm_flag & FFC_VTERM_START_FLAG)) {
        cnt++;
        if (cnt >= FFC_CHARGE_EXIT_TIMES)
            di->ffc_vterm_flag |= FFC_VETRM_END_FLAG;
    }
    
    return ffc_vterm;
}
```

**关键状态机**：
- `FFC_VTERM_START_FLAG` (BIT0)：FFC 已启动
- `FFC_VETRM_END_FLAG` (BIT1)：FFC 已结束

### 4.2 温度补偿算法（ffc_get_buck_vterm_with_temp）

```c
int ffc_get_buck_vterm_with_temp(struct ffc_ctrl_dev *di)
{
    int tbat = 0;
    int i;
    struct ffc_buck_term_para *para = ffc_select_buck_term_para(di);
    
    bat_temp_get_temperature(BAT_TEMP_MIXED, &tbat);
    
    for (i = 0; i < FFC_MAX_CHARGE_TERM; i++) {
        if ((tbat >= para[i].temp_low) && (tbat <= para[i].temp_high))
            return para[i].vterm_gain;  // 返回该温度段的电压增量
    }
    
    return 0;  // 温度不在配置范围内，不增压
}
```

### 4.3 电流条件判断算法（ffc_get_buck_vterm）

```c
int ffc_get_buck_vterm(struct ffc_ctrl_dev *di)
{
    int tbat = 0;
    int ichg_avg = charge_get_battery_current_avg();  // 获取平均充电电流
    unsigned int vterm_dec = 0;
    
    charge_get_vterm_dec(&vterm_dec);  // 获取电压降标志
    bat_temp_get_temperature(BAT_TEMP_MIXED, &tbat);
    
    for (i = 0; i < FFC_MAX_CHARGE_TERM; i++) {
        if ((tbat >= para[i].temp_low) && (tbat <= para[i].temp_high)) {
            // 条件1：电流高于阈值
            // 条件2：硅基电池且有电压降
            if ((ichg_avg > para[i].ichg_thre) || 
                (vterm_dec && (di->bat_type == BATTERY_SI))) {
                return para[i].vterm_gain;
            }
        }
    }
    
    return 0;  // 不满足条件，停止增压
}
```

**逻辑解释**：
- **电流阈值检查**：当前电流 > ichg_thre 时继续增压（表示电池仍有充电空间）
- **硅基电池特殊处理**：检测到电压降时也允许增压（硅基电池特性）

### 4.4 电池型号匹配算法（ffc_select_buck_term_para）

```c
static struct ffc_buck_term_para *ffc_select_buck_term_para(struct ffc_ctrl_dev *di)
{
    const char *brand = power_supply_app_get_bat_brand();  // 获取电池品牌
    int bat_type = bat_model_get_bat_cathode_type();       // 获取电池类型
    
    // 转换电池类型
    switch (bat_type) {
    case BAT_MODEL_BAT_CATHODE_TYPE_GRAPHITE:
        bat_type = BATTERY_C;    // 石墨电池
        break;
    case BAT_MODEL_BAT_CATHODE_TYPE_SILICON:
        bat_type = BATTERY_SI;   // 硅基电池
        break;
    }
    
    // 遍历参数组匹配
    for (i = 0; i < di->group_size; i++) {
        if (!strstr(brand, di->ffc_term_para_group[i].bat_info.bat_sn))
            continue;  // 品牌不匹配
        
        if (bat_type != di->ffc_term_para_group[i].bat_info.bat_type)
            continue;  // 类型不匹配
        
        // 匹配成功，复制参数
        memcpy(di->buck_term_para, 
               di->ffc_term_para_group[i].term_para_group, 
               sizeof(di->buck_term_para));
        di->term_para_select_ok = true;
        di->bat_type = bat_type;
        break;
    }
    
    return di->buck_term_para;
}
```

---

## 五、事件处理机制

### 5.1 事件订阅
```c
static int ffc_ctrl_probe(struct platform_device *pdev)
{
    // 订阅充电事件
    power_event_bnc_register(POWER_BNT_CHARGING, &di->event_nb);
    
    // 订阅 DC 直充事件
    power_event_bnc_register(POWER_BNT_DC, &di->event_dc_nb);
    
    // 订阅 FCP 快充事件
    power_event_bnc_register(POWER_BNT_FCP, &di->event_fcp_nb);
}
```

### 5.2 事件处理逻辑
```c
static int ffc_ctrl_event_notifier_call(struct notifier_block *nb, 
                                         unsigned long event, void *data)
{
    switch (event) {
    case POWER_NE_CHARGING_STOP:
        // 充电停止：复位所有状态
        di->ffc_vterm_flag = 0;
        di->dc_adp = false;
        di->fcp_adp = false;
        di->ffc_delay_cnt = 0;
        charge_update_iterm(g_default_iterm);
        break;
        
    case POWER_NE_DC_CHECK_START:
        // DC 检测开始：标记 DC 适配器
        di->dc_adp = true;
        break;
        
    case POWER_NE_FCP_CHARGING_START:
        // FCP 充电开始：标记 FCP 适配器（若支持）
        if (di->fcp_support_ffc)
            di->fcp_adp = true;
        break;
    }
    
    return NOTIFY_OK;
}
```

---

## 六、DTS 配置说明

### 6.1 基础配置示例
```dts
ffc_control {
    compatible = "huawei,ffc_control";
    
    /* 延迟次数配置（默认 2 次） */
    delay_times = <2>;
    
    /* FCP 是否支持 FFC */
    fcp_support_ffc;
    
    /* 默认充电参数（温度分段） */
    buck_term_para = <
        /* temp_low, temp_high, vterm_gain, ichg_thre, iterm */
        0   100   0    0     160
        100 200   30   800   180
        200 450   50   1000  200
    >;
};
```

### 6.2 多电池配置示例
```dts
ffc_control {
    /* 电池参数组配置 */
    ffc_bat_para = <
        /* bat_sn        bat_type         buck_term_para_index */
        "ATL"          "0"              "atl_c_term_para"
        "ATL"          "1"              "atl_si_term_para"
        "SUNWODA"      "0"              "sunwoda_c_term_para"
    >;
    
    /* ATL 石墨电池参数 */
    atl_c_term_para = <
        100 200   35   850   180
        200 450   55   1050  210
    >;
    
    /* ATL 硅基电池参数 */
    atl_si_term_para = <
        100 200   40   900   190
        200 450   60   1100  220
    >;
    
    /* SUNWODA 石墨电池参数 */
    sunwoda_c_term_para = <
        100 200   30   800   170
        200 450   50   1000  200
    >;
};
```

**配置参数说明**：
- `bat_sn`：电池序列号（用于品牌匹配）
- `bat_type`：0=石墨电池（BATTERY_C），1=硅基电池（BATTERY_SI）
- `buck_term_para_index`：指向具体参数表的索引名

---

## 七、典型应用场景

### 7.1 场景1：直充转 BUCK 充电
```
时序图：
DC Charging (40W) → DC Done → Switch to BUCK → FFC Control

1. DC 充电阶段（4.4V → 4.45V）：
   - ffc_ctrl_get_incr_vterm() 返回温度补偿值（如 30mV）
   - VBAT 充至 4.45V

2. DC 转 BUCK 阶段：
   - direct_charge_check_charge_done() 返回 true
   - 延迟计数器生效（2 次 * 充电周期）

3. BUCK FFC 阶段：
   - 检查 ichg_avg > ichg_thre（如 1000mA > 800mA）
   - 继续增加 Vterm（如 +50mV → 4.50V）
   - 直到电流降至阈值以下

4. FFC 结束阶段：
   - 连续 2 次返回 vterm_gain=0
   - 设置 FFC_VETRM_END_FLAG
   - 更新 iterm 为最终值（如 200mA）
```

### 7.2 场景2：FCP 快充
```
时序图：
FCP Detect → FCP Charging (18W) → FFC Control

1. FCP 检测阶段：
   - POWER_NE_FCP_CHARGING_START 事件触发
   - 设置 di->fcp_adp = true（需 fcp_support_ffc 配置）

2. FCP 充电阶段：
   - ffc_ctrl_get_incr_vterm() 返回温度补偿值
   - 根据温度区间提升 Vterm

3. 充电停止：
   - POWER_NE_CHARGING_STOP 事件
   - 复位所有状态
```

### 7.3 场景3：温度变化适配
```
温度变化：15°C → 25°C → 40°C

1. 15°C（100 ≤ tbat < 200）：
   - vterm_gain = 30mV
   - ichg_thre = 800mA
   - iterm = 180mA

2. 25°C（200 ≤ tbat ≤ 450）：
   - vterm_gain = 50mV (自动切换)
   - ichg_thre = 1000mA
   - iterm = 200mA

3. 40°C（仍在 200-450 范围）：
   - 保持相同参数
```

---

## 八、关键接口说明

### 8.1 对外接口

#### ffc_ctrl_get_incr_vterm()
```c
int ffc_ctrl_get_incr_vterm(void);
```
- **功能**：获取当前应增加的充电截止电压值
- **返回值**：电压增量（mV），0 表示不增压
- **调用时机**：充电框架每次更新 Vterm 时调用

#### ffc_ctrl_notify_ffc_info()
```c
void ffc_ctrl_notify_ffc_info(void);
```
- **功能**：通知系统当前 FFC 充电状态信息
- **通知内容**：`struct ffc_ctrl_charge_info` (ffc_charge_flag, dc_mode, iterm)
- **事件通道**：`POWER_BNT_BUCK_CHARGE` / `POWER_NE_BUCK_FFC_CHARGE`

#### ffc_ctrl_set_default_info()
```c
void ffc_ctrl_set_default_info(int vterm, int iterm);
```
- **功能**：设置默认的 Vterm 和 Iterm 值
- **参数**：
  - `vterm`：默认截止电压（如 4450mV）
  - `iterm`：默认截止电流（如 160mA）

### 8.2 内部接口

#### ffc_get_buck_vterm_with_temp()
```c
int ffc_get_buck_vterm_with_temp(struct ffc_ctrl_dev *di);
```
- **功能**：仅根据温度返回电压增量（不考虑电流条件）
- **应用场景**：DC 充电阶段、延迟阶段

#### ffc_get_buck_vterm()
```c
int ffc_get_buck_vterm(struct ffc_ctrl_dev *di);
```
- **功能**：根据温度 + 电流条件返回电压增量
- **应用场景**：BUCK FFC 充电阶段

#### ffc_get_buck_iterm()
```c
int ffc_get_buck_iterm(struct ffc_ctrl_dev *di);
```
- **功能**：根据温度返回截止电流
- **应用场景**：FFC 结束时更新 iterm

#### ffc_get_buck_ichg_th()
```c
int ffc_get_buck_ichg_th(struct ffc_ctrl_dev *di);
```
- **功能**：返回当前温度段的电流阈值
- **应用场景**：判断是否应继续 FFC

---

## 九、调试方法

### 9.1 日志关键点
```bash
# 1. 查看温度和电压增量
[ffc_base] tbat=250, vterm_gain=50

# 2. 查看电流条件判断
[ffc_base] ichg_avg=1050, tbat=250
[ffc_base] buck set vterm increase 50

# 3. 查看参数选择
[ffc_base] bat brand=ATL, bat_type=0
[ffc_base] ffc_bat_para[0]=ATL 0 atl_c_term_para

# 4. 查看事件触发
[ffc_control] dc check start
[ffc_control] charge stop, ffc charge set default

# 5. 查看 FFC 状态通知
[ffc_control] ffc_charge_flag=1 dc_mode=1 iterm=200
```

### 9.2 Sysfs 调试节点
虽然代码中未直接实现，但可通过相关接口调试：
```bash
# 查看当前充电电流
cat /sys/class/power_supply/battery/current_now

# 查看电池温度
cat /sys/class/power_supply/battery/temp

# 查看充电电压
cat /sys/class/power_supply/battery/voltage_now
```

### 9.3 常见问题排查

#### 问题1：FFC 未启动
**现象**：`ffc_ctrl_get_incr_vterm()` 始终返回 0

**排查步骤**：
1. 检查是否识别到 DC/FCP 适配器：
   ```c
   // 查看日志是否有 "dc check start" 或 "fcp check start"
   ```
2. 检查 DTS 配置是否加载：
   ```c
   // di->buck_term_para_flag 是否为 true
   ```
3. 检查温度是否在配置范围内：
   ```c
   // tbat 是否在 temp_low ~ temp_high 范围
   ```

#### 问题2：FFC 过早结束
**现象**：充电电压未达预期即停止增压

**排查步骤**：
1. 检查电流阈值配置：
   ```c
   // ichg_thre 是否设置过高
   ```
2. 检查退出计数器：
   ```c
   // FFC_CHARGE_EXIT_TIMES 是否过小（默认 2 次）
   ```

#### 问题3：硅基电池未正确识别
**现象**：参数匹配使用了默认石墨电池参数

**排查步骤**：
1. 检查电池型号接口：
   ```c
   bat_type = bat_model_get_bat_cathode_type();
   hwlog_info("bat_type=%d\n", bat_type);
   ```
2. 检查品牌匹配：
   ```c
   brand = power_supply_app_get_bat_brand();
   hwlog_info("brand=%s\n", brand);
   ```

---

## 十、总结

### 10.1 技术特点
1. **自适应调节**：根据温度、电流、电池类型动态调整充电参数
2. **安全优先**：通过电流阈值、延迟机制防止过充
3. **多场景兼容**：支持 DC、FCP 等多种充电协议
4. **灵活配置**：DTS 支持多电池型号差异化参数

### 10.2 设计亮点
- **状态机管理**：通过 `ffc_vterm_flag` 精确控制 FFC 生命周期
- **电池识别**：品牌 + 类型双重匹配确保参数准确性
- **温度分段**：最多 8 个温度区间实现精细化控制
- **电压降检测**：硅基电池特殊处理提升充电效率

### 10.3 应用价值
- **提升充电容量**：通过 Vterm 增益可额外充入 3-5% 电量
- **优化用户体验**：缩短充满时间，提高续航表现
- **延长电池寿命**：温度感知机制避免高温过充
