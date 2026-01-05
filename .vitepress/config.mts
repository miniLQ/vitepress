import { defineConfig } from 'vitepress';
import plantuml from 'markdown-it-plantuml';

import { withMermaid } from 'vitepress-plugin-mermaid';

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "林渡的内核笔记",
  description: "A VitePress Site",
  //ignoreDeadLinks: true,
  markdown: {
    config: (md) => {
      // Use the PlantUML plugin
      md.use(plantuml);
      // Or if using the newer version:
      // md.use(plantuml);
    }
  },

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'start', link: '/getting-started' }
    ],

    sidebar: [
      {
        text: '开始',
        collapsed: false,  // 默认展开
        items: [
          { text: '快速开始', link: '/getting-started' }
        ]
      },
      /*
      {
        text: 'Linux 内存管理',
        collapsed: true,  // 默认折叠
        items: [
          { text: '专题概览', link: '/memory/overview' },
          { 
            text: '基础概念',
            collapsed: true,
            items: [
              { text: '内存管理机制', link: '/memory/basic-concepts' },
              { text: '内存分布', link: '/memory/memory-layout' },
              { text: '页表管理', link: '/memory/page-table' }
            ]
          },
          {
            text: '内存分配器',
            collapsed: true,
            items: [
              { text: 'Memblock 分配器', link: '/memory/memblock' },
              { text: 'Buddy 系统', link: '/memory/buddy' },
              { text: 'Slub 分配器', link: '/memory/slub' }
            ]
          },
          {
            text: '内存回收',
            collapsed: true,
            items: [
              { text: 'Watermark 机制', link: '/memory/watermark' },
              { text: '页面回收', link: '/memory/reclaim' },
              { text: 'OOM Killer', link: '/memory/oom' }
            ]
          },
          {
            text: '资源控制',
            collapsed: true,
            items: [
              { text: 'Cgroup', link: '/memory/cgroup' },
              { text: 'Memcg', link: '/memory/memcg' },
              { text: 'PSI 压力指标', link: '/memory/psi' }
            ]
          }
        ]
      },
      {
        text: 'ARM 架构',
        collapsed: true,  // 默认折叠
        items: [
          { text: '专题概览', link: '/arm/overview' },
          {
            text: '架构基础',
            collapsed: true,
            items: [
              { text: 'ARMv8/v9 架构', link: '/arm/architecture' },
              { text: 'ARM 指令集', link: '/arm/instruction-set' }
            ]
          },
          {
            text: '硬件特性',
            collapsed: true,
            items: [
              { text: 'MMU & Cache', link: '/arm/mmu-cache' },
              { text: 'GIC 中断控制器', link: '/arm/gic' },
              { text: 'TrustZone', link: '/arm/trustzone' }
            ]
          }
        ]
      },
      {
        text: '系统稳定性',
        collapsed: true,  // 默认折叠
        items: [
          { text: '专题概览', link: '/stability/overview' },
          {
            text: '调试工具',
            collapsed: true,
            items: [
              { text: 'Trace32', link: '/stability/trace32' },
              { text: 'ftrace & perf', link: '/stability/ftrace-perf' }
            ]
          },
          {
            text: '问题分析',
            collapsed: true,
            items: [
              { text: 'Panic 分析', link: '/stability/panic' },
              { text: '性能优化', link: '/stability/performance' }
            ]
          }
        ]
      },
      */
      {
        text: '华为充电管理架构',
        collapsed: true,  // 默认折叠
        items: [
          { text: '系统架构概览', link: '/hw_charging/overview' },
          {
            text: '1️⃣ 用户空间接口层',
            collapsed: true,
            items: [
              { text: 'sysfs 文件系统', link: '/hw_charging/user-interface/sysfs' },
              { text: 'uevent 事件机制', link: '/hw_charging/user-interface/uevent' },
              { text: 'power_supply 子系统', link: '/hw_charging/user-interface/power-supply' },
              { text: 'Android HAL 接口', link: '/hw_charging/user-interface/android-hal' }
            ]
          },
          {
            text: '2️⃣ 业务逻辑管理层',
            collapsed: true,
            items: [
              { 
                text: '充电管理器 (charge_manager)',
                collapsed: true,
                items: [
                  { text: '充电模式选择', link: '/hw_charging/business/charge-manager/mode-selection' },
                  { text: '充电状态机', link: '/hw_charging/business/charge-manager/state-machine' },
                  { text: '协议协商', link: '/hw_charging/business/charge-manager/protocol-negotiation' },
                  { text: '故障处理', link: '/hw_charging/business/charge-manager/fault-handling' }
                ]
              },
              { 
                text: '电池核心 (battery_core)',
                collapsed: true,
                items: [
                  { text: '电池状态监控', link: '/hw_charging/battery-core/overview#定期刷新机制（核心循环）' },
                  { text: '温度补偿与 NTC 校准', link: '/hw_charging/battery-core/overview#温度的判定' },
                  { text: '流程图', link: '/hw_charging/battery-core/overview#流程图' },
                ]
              },
              {
                text: '充电模式实现',
                collapsed: true,
                items: [
                  { text: 'Buck 充电模式', link: '/hw_charging/business/charge-modes/buck-charge' },
                  { text: '直充模式 (SCP/LVC)', link: '/hw_charging/business/charge-modes/direct-charge' },
                  { text: 'HVDCP 快充', link: '/hw_charging/business/charge-modes/hvdcp' },
                  { text: '无线充电', link: '/hw_charging/business/charge-modes/wireless' }
                ]
              },
              {
                text: '电池管理子模块',
                collapsed: true,
                items: [
                  { text: '1S2P 电池拓扑', link: '/hw_charging/business/battery-modules/1s2p' },
                  { text: 'CC/CV 充电算法', link: '/hw_charging/business/battery-modules/cccv' },
                  { text: '电荷平衡管理', link: '/hw_charging/business/battery-modules/charge-balance' },
                  { text: '电池模型与参数', link: '/hw_charging/business/battery-modules/battery-model' },
                  { text: '电池健康度 (SOH)', link: '/hw_charging/business/battery-modules/soh' },
                  { text: 'UI 电量显示', link: '/hw_charging/business/battery-modules/ui-capacity' }
                ]
              }
            ]
          },
          {
            text: '3️⃣ 协议与算法层',
            collapsed: true,
            items: [
              { 
                text: '事件系统 (power_event)',
                collapsed: true,
                items: [
                  { text: '事件驱动框架', link: '/hw_charging/protocol/event-system/framework' },
                  { text: '连接事件 (USB/Wireless/OTG)', link: '/hw_charging/protocol/event-system/connect-events' },
                  { text: '充电事件 (Start/Stop/Done)', link: '/hw_charging/protocol/event-system/charge-events' },
                  { text: '故障事件 (OVP/OCP/OTP)', link: '/hw_charging/protocol/event-system/fault-events' },
                  { text: 'Notifier 机制', link: '/hw_charging/protocol/event-system/notifier' }
                ]
              },
              { 
                text: '投票系统 (power_vote)',
                collapsed: true,
                items: [
                  { text: '投票决策机制', link: '/hw_charging/protocol/vote-system/mechanism' },
                  { text: '客户端类型与优先级', link: '/hw_charging/protocol/vote-system/clients' },
                  { text: 'FCC/ICL 投票', link: '/hw_charging/protocol/vote-system/fcc-icl' },
                  { text: '温度与电压投票', link: '/hw_charging/protocol/vote-system/temp-voltage' }
                ]
              },
              {
                text: '充电协议',
                collapsed: true,
                items: [
                  { text: 'USB PD 协议', link: '/hw_charging/protocol/protocols/usb-pd' },
                  { text: 'SCP 超级快充', link: '/hw_charging/protocol/protocols/scp' },
                  { text: 'FCP 快充协议', link: '/hw_charging/protocol/protocols/fcp' },
                  { text: 'UFCS 融合快充', link: '/hw_charging/protocol/protocols/ufcs' },
                  { text: 'Qi 无线充电协议', link: '/hw_charging/protocol/protocols/qi' }
                ]
              },
              {
                text: '算法库',
                collapsed: true,
                items: [
                  { text: 'SOC 估算算法', link: '/hw_charging/protocol/algorithms/soc-estimation' },
                  { text: '充电曲线优化', link: '/hw_charging/protocol/algorithms/charge-curve' },
                  { text: '温度预测算法', link: '/hw_charging/protocol/algorithms/temp-prediction' }
                ]
              }
            ]
          },
          {
            text: '4️⃣ 硬件抽象与驱动层',
            collapsed: true,
            items: [
              { 
                text: '电量计驱动 (coul)',
                collapsed: true,
                items: [
                  { text: '电量计接口抽象', link: '/hw_charging/hardware/coul/interface' },
                  { text: 'RT9426 驱动', link: '/hw_charging/hardware/coul/rt9426' },
                  { text: 'MAX1726x 驱动', link: '/hw_charging/hardware/coul/max1726x' },
                  { text: 'SOC 校准', link: '/hw_charging/hardware/coul/soc-calibration' }
                ]
              },
              { 
                text: '充电 IC 驱动',
                collapsed: true,
                items: [
                  { text: '充电 IC 接口抽象', link: '/hw_charging/hardware/charge-ic/interface' },
                  { text: 'BQ2560x 系列', link: '/hw_charging/hardware/charge-ic/bq2560x' },
                  { text: 'BQ25713 系列', link: '/hw_charging/hardware/charge-ic/bq25713' },
                  { text: 'SC8551 系列', link: '/hw_charging/hardware/charge-ic/sc8551' }
                ]
              },
              {
                text: '硬件通道管理',
                collapsed: true,
                items: [
                  { text: 'VBUS 通道管理', link: '/hw_charging/hardware/channel/vbus' },
                  { text: '线缆识别与认证', link: '/hw_charging/hardware/channel/cable-auth' },
                  { text: '无线充电 Tx/Rx', link: '/hw_charging/hardware/channel/wireless-txrx' }
                ]
              },
              {
                text: '温度传感器',
                collapsed: true,
                items: [
                  { text: 'NTC 温度采集', link: '/hw_charging/hardware/temp-sensor/ntc' },
                  { text: '多点温度监控', link: '/hw_charging/hardware/temp-sensor/multi-point' },
                  { text: '温度补偿算法', link: '/hw_charging/hardware/temp-sensor/compensation' }
                ]
              }
            ]
          },
          {
            text: '5️⃣ 安全与保护机制',
            collapsed: true,
            items: [
              { text: '过压保护 (OVP)', link: '/hw_charging/protection/ovp' },
              { text: '过流保护 (OCP)', link: '/hw_charging/protection/ocp' },
              { text: '过温保护 (OTP)', link: '/hw_charging/protection/otp' },
              { text: '电池健康保护', link: '/hw_charging/protection/battery-health' },
              { text: '软硬件双重保护', link: '/hw_charging/protection/dual-protection' },
              { text: '故障恢复机制', link: '/hw_charging/protection/fault-recovery' }
            ]
          },
          {
            text: '6️⃣ 工作流程与时序',
            collapsed: true,
            items: [
              { text: '充电启动流程', link: '/hw_charging/workflow/charge-start' },
              { text: '协议握手时序', link: '/hw_charging/workflow/protocol-handshake' },
              { text: '模式切换流程', link: '/hw_charging/workflow/mode-switch' },
              { text: '事件处理流程', link: '/hw_charging/workflow/event-handling' },
              { text: '投票决策流程', link: '/hw_charging/workflow/vote-decision' }
            ]
          },
          {
            text: '7️⃣ 调试与分析',
            collapsed: true,
            items: [
              { text: 'sysfs 调试接口', link: '/hw_charging/debug/sysfs-debug' },
              { text: '日志分析方法', link: '/hw_charging/debug/log-analysis' },
              { text: '常见问题排查', link: '/hw_charging/debug/troubleshooting' },
              { text: '性能优化建议', link: '/hw_charging/debug/performance-tuning' }
            ]
          }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/vuejs/vitepress' }
    ]
  }
})

