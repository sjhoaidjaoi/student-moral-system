<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  // [{ value, label }]
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请选择' },
  emptyText: { type: String, default: '暂无可选项' },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const open = ref(false)
const keyword = ref('')
const box = ref(null)

const selectedLabel = computed(() =>
  props.options.find(
    item => String(item.value) === String(props.modelValue)
  )?.label || ''
)

const filteredOptions = computed(() => {
  const key = keyword.value.trim().toLowerCase()

  if (!key) return props.options

  return props.options.filter(
    item =>
      String(item.label).toLowerCase().includes(key) ||
      String(item.value).toLowerCase().includes(key)
  )
})

function toggleOpen() {
  if (props.disabled) return

  open.value = !open.value

  if (open.value) {
    keyword.value = ''
  }
}

function choose(item) {
  emit('update:modelValue', String(item.value))
  open.value = false
}

function onDocumentClick(event) {
  if (box.value && !box.value.contains(event.target)) {
    open.value = false
  }
}

onMounted(() => document.addEventListener('click', onDocumentClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))
</script>

<template>
  <div ref="box" class="search-select">
    <div
      class="ss-control"
      :class="{ 'is-open': open, 'is-disabled': disabled }"
      @click="toggleOpen"
    >
      <input
        class="ss-input"
        :value="open ? keyword : selectedLabel"
        :placeholder="open ? '输入关键字搜索...' : placeholder"
        :disabled="disabled"
        @input="keyword = $event.target.value"
      />
      <span class="ss-arrow" :class="{ 'is-open': open }">▾</span>
    </div>

    <div v-if="open" class="ss-menu">
      <button
        v-for="item in filteredOptions"
        :key="item.value"
        type="button"
        class="ss-option"
        :class="{ 'is-active': String(item.value) === String(modelValue) }"
        @click.stop="choose(item)"
      >
        {{ item.label }}
      </button>
      <p v-if="!filteredOptions.length" class="ss-empty">
        {{ keyword ? '无匹配结果' : emptyText }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.search-select {
  position: relative;
  width: 100%;
}

.ss-control {
  display: flex;
  align-items: center;
  border: 1px solid #d9dce7;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.ss-control:hover {
  border-color: #a9b1d6;
}

.ss-control.is-open {
  border-color: #6a5af9;
  box-shadow: 0 0 0 3px rgba(106, 90, 249, 0.12);
}

.ss-control.is-disabled {
  background: #f3f4f8;
  cursor: not-allowed;
  opacity: 0.7;
}

.ss-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  padding: 9px 11px;
  font-size: 13px;
  color: #2c2f3a;
  cursor: inherit;
}

.ss-input::placeholder {
  color: #a0a6b5;
}

.ss-arrow {
  padding: 0 11px;
  font-size: 12px;
  color: #8b90a0;
  transition: transform 0.15s;
}

.ss-arrow.is-open {
  transform: rotate(180deg);
}

.ss-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 60;
  max-height: 240px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid #e3e5ee;
  border-radius: 8px;
  box-shadow: 0 10px 28px rgba(35, 40, 70, 0.14);
  padding: 4px;
}

.ss-option {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  color: #2c2f3a;
  cursor: pointer;
}

.ss-option:hover {
  background: #f1efff;
  color: #5a49e0;
}

.ss-option.is-active {
  background: #6a5af9;
  color: #fff;
}

.ss-empty {
  padding: 10px;
  text-align: center;
  font-size: 12px;
  color: #9aa0af;
}
</style>
