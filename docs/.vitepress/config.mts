import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Global Control Assistant',
  description: '跨设备远程控制与 AI 自动化系统',
  lang: 'zh-CN',
  cleanUrls: true,
  lastUpdated: true,

  // 强制暗色模式，避免浅色模式下变量冲突
  appearance: 'dark',

  themeConfig: {
    darkModeSwitchLabel: '主题',
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',

    // 导航栏
    nav: [
      { text: '首页', link: '/' },
      { text: '架构', link: '/architecture' },
      { text: '能力', link: '/capabilities' },
      { text: '路线图', link: '/roadmap' },
      {
        text: '更多',
        items: [
          { text: '安全分析', link: '/security' },
          { text: '维护优化', link: '/maintenance' },
          { text: 'PM 审查', link: '/pm-review' },
          { text: '开发代办', link: '/backlog' },
          { text: '系统流程', link: '/flow' },
          { text: '信息优化方案', link: '/optimization' },
          { text: '可行性分析', link: '/feasibility' },
          { text: 'AI 模型策略', link: '/ai-strategy' },
          { text: 'PM 工具箱', link: '/pm-doc-toolkit' },
        ]
      }
    ],

    // 侧边栏
    sidebar: {
      '/': [
        {
          text: '项目文档',
          items: [
            { text: '首页', link: '/' },
            { text: '系统架构', link: '/architecture' },
            { text: '能力全景', link: '/capabilities' },
            { text: '实施路线图', link: '/roadmap' },
            { text: '安全分析', link: '/security' },
            { text: '维护优化', link: '/maintenance' },
            { text: 'PM 审查', link: '/pm-review' },
            { text: '开发代办', link: '/backlog' },
            { text: '系统流程', link: '/flow' },
            { text: '信息优化方案', link: '/optimization' },
            { text: '可行性分析', link: '/feasibility' },
            { text: 'AI 模型策略', link: '/ai-strategy' },
            { text: 'PM 工具箱', link: '/pm-doc-toolkit' },
          ]
        }
      ]
    },

    // 社交链接
    socialLinks: [
      { icon: 'github', link: 'https://github.com' }
    ],

    // 搜索
    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档'
          },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: {
              selectText: '选择',
              navigateText: '切换'
            }
          }
        }
      }
    },

    // 页脚
    footer: {
      message: '基于 OpenClaw + MCP 构建',
      copyright: 'Global Control Assistant © 2026'
    },

    // 大纲
    outline: {
      label: '本页目录',
      level: [2, 3]
    },

    // 上下一页
    docFooter: {
      prev: '上一页',
      next: '下一页'
    },

    // 最后更新时间
    lastUpdatedText: '最后更新',

    // 编辑链接
    editLink: {
      pattern: 'https://github.com/edit/main/docs/:path',
      text: '在 GitHub 上编辑此页'
    }
  }
})
