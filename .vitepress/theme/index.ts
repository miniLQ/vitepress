import DefaultTheme from 'vitepress/theme'
import mediumZoom from 'medium-zoom'
import { onMounted, watch, nextTick } from 'vue'
import { useRoute } from 'vitepress'
import type { Theme } from 'vitepress'

import './style.css'

export default {
  extends: DefaultTheme,
  setup() {
    const route = useRoute()
    let zoom: ReturnType<typeof mediumZoom> | null = null

    const bind = () => {
      // 如果已经有实例，就先 detach 再 attach，避免重复绑定
      if (!zoom) {
        zoom = mediumZoom({
          margin: 32,
          scrollOffset: 0,
          container: document.body
        })
      }

      // 先清掉旧的（防止切页重复绑定）
      zoom.detach()
      // 只放大正文图片；排除表情/小图标/徽章（可按需增删）
      zoom.attach('.vp-doc img:not(.no-zoom)')
    }

    onMounted(bind)

    watch(
      () => route.path,
      async () => {
        await nextTick()
        bind()
      }
    )
  }
} satisfies Theme
