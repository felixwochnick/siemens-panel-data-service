// Siemens-Design für Nuxt UI: Farben, Siemens-Icons und Komponenten-Varianten
export default defineAppConfig({
  ui: {
    icons: {
      arrowDown: 'siemens:arrow-down',
      arrowLeft: 'siemens:arrow-left',
      arrowRight: 'siemens:arrow-right',
      arrowUp: 'siemens:arrow-up',
      caution: 'siemens:circle-warning',
      check: 'siemens:checkmark-medium',
      chevronDoubleLeft: 'siemens:chevron-double-left',
      chevronDoubleRight: 'siemens:chevron-double-right',
      chevronDown: 'siemens:chevron-down',
      chevronLeft: 'siemens:chevron-left',
      chevronRight: 'siemens:chevron-right',
      chevronUp: 'siemens:chevron-up',
      close: 'siemens:close',
      copy: 'siemens:copy',
      copyCheck: 'siemens:checkmark-small',
      dark: 'siemens:moon',
      drag: 'siemens:drag-and-drop',
      ellipsis: 'siemens:options-horizontal',
      error: 'siemens:circle-error',
      external: 'siemens:link-extern',
      eye: 'siemens:view',
      eyeOff: 'siemens:view-off',
      file: 'siemens:document',
      folder: 'siemens:folder',
      folderOpen: 'siemens:folder-open',
      hash: 'siemens:link',
      info: 'siemens:circle-information',
      light: 'siemens:sun',
      loading: 'siemens:refresh',
      menu: 'siemens:menu',
      minus: 'siemens:minus-small',
      panelClose: 'siemens:chevron-double-left',
      panelOpen: 'siemens:chevron-double-right',
      plus: 'siemens:plus-medium',
      reload: 'siemens:refresh',
      search: 'siemens:search',
      stop: 'siemens:stop',
      success: 'siemens:circle-checkmark',
      system: 'siemens:monitor',
      tip: 'siemens:explore',
      upload: 'siemens:upload',
      warning: 'siemens:circle-warning',
    },
    colors: {
      primary: 'siemens-primary',
      secondary: 'blue',
      tertiary: 'blue',
      success: 'green',
      info: 'blue',
      warning: 'yellow',
      error: 'red',
      neutral: 'neutral',
    },

    // ── Page layout ──────────────────────────────────────────────────
    pageBody: {
      base: 'space-y-0',
    },

    // ── Button ───────────────────────────────────────────────────────
    button: {
      defaultVariants: {
        color: 'primary',
        variant: 'siemens',
      },
      variants: {
        variant: {
          siemens: 'px-3.5 py-2 text-sm font-bold disabled:opacity-100 focus:outline focus:outline-solid focus:outline-offset-1 focus:outline-(--color-siemens-interaction-focus-border)',
        },
      },
      compoundVariants: [
        // Primary solid (filled teal — main action)
        {
          color: 'primary',
          variant: 'siemens',
          class: 'bg-(--ui-color-siemens) text-inverted hover:bg-(--ui-color-siemens-hover) active:bg-(--ui-color-siemens-active) disabled:bg-(--ui-color-siemens-disabled-background) disabled:text-(--ui-color-siemens-disabled-text)',
        },
        // Secondary solid (outlined — secondary action)
        {
          color: 'secondary',
          variant: 'siemens',
          class: 'border bg-transparent disabled:bg-transparent border-(--ui-color-siemens) text-(--ui-color-siemens) hover:border-(--ui-color-siemens-hover) hover:bg-(--ui-color-siemens-hover-background) hover:text-(--ui-color-siemens-hover) active:border-(--ui-color-siemens-active) active:bg-transparent! active:text-(--ui-color-siemens-active) disabled:border-(--ui-color-siemens-disabled-text) disabled:text-(--ui-color-siemens-disabled-text)',
        },
        // Tertiary solid (ghost — low-emphasis action)
        {
          color: 'tertiary',
          variant: 'siemens',
          class: 'bg-transparent text-(--ui-color-siemens) hover:bg-(--ui-color-siemens-hover-background) hover:text-(--ui-color-siemens-hover) active:bg-transparent! active:text-(--ui-color-siemens-active) disabled:text-(--ui-color-siemens-disabled-text)! disabled:bg-transparent!',
        },
        // Primary outline (secondary button style)
        {
          color: 'primary',
          variant: 'outline',
          class: 'border bg-transparent border-(--ui-color-siemens) text-(--ui-color-siemens) hover:border-(--ui-color-siemens-hover) hover:bg-(--ui-color-siemens-hover-background) hover:text-(--ui-color-siemens-hover) active:border-(--ui-color-siemens-active) active:bg-transparent! active:text-(--ui-color-siemens-active) disabled:border-(--ui-color-siemens-disabled-text) disabled:text-(--ui-color-siemens-disabled-text)',
        },
        // Primary ghost (tertiary button style)
        {
          color: 'primary',
          variant: 'ghost',
          class: 'bg-transparent text-(--ui-color-siemens) hover:bg-(--ui-color-siemens-hover-background) hover:text-(--ui-color-siemens-hover) active:bg-transparent! active:text-(--ui-color-siemens-active) disabled:text-(--ui-color-siemens-disabled-text)! disabled:bg-transparent!',
        },
        // Primary link
        {
          color: 'primary',
          variant: 'link',
          class: 'text-(--ui-color-siemens) underline-offset-2 hover:underline hover:text-(--ui-color-siemens-hover) active:text-(--ui-color-siemens-active) disabled:text-(--ui-color-siemens-disabled-text)!',
        },
        // Primary soft
        {
          color: 'primary',
          variant: 'soft',
          class: 'bg-(--ui-color-siemens-hover-background) text-(--ui-color-siemens) hover:bg-(--color-siemens-interaction-light-light-green)/30 hover:text-(--ui-color-siemens-hover) active:text-(--ui-color-siemens-active) disabled:bg-(--ui-color-siemens-disabled-background) disabled:text-(--ui-color-siemens-disabled-text)',
        },
      ],
    },

    // ── Form field ───────────────────────────────────────────────────
    formField: {
      variants: {
        required: {
          true: {
            label: 'after:text-(--ui-text)',
          },
        },
      },
    },

    // ── Input ────────────────────────────────────────────────────────
    input: {
      variants: {
        variant: {
          siemens: 'border-0 border-b-1 border-(--ui-color-input-field-border) bg-(--ui-color-input-field-background) text-(--ui-text) rounded-none placeholder:text-(--ui-color-input-field-border) hover:border-(--ui-color-siemens-hover) hover:bg-(--ui-color-siemens-hover-background) active:border-(--ui-color-siemens-hover) active:bg-(--ui-color-siemens-hover-background) focus:bg-(--ui-color-siemens-hover-background) focus:outline focus:outline-solid focus:outline-offset-1 focus:outline-(--color-siemens-interaction-focus-border) disabled:bg-(--ui-color-siemens-disabled-background) disabled:text-(--ui-color-siemens-disabled-text) disabled:border-b-0 disabled:cursor-not-allowed',
        },
      },
      compoundVariants: [
        {
          color: 'error',
          variant: 'siemens',
          class: 'border-(--ui-color-input-field-error)! bg-(--ui-color-input-field-error-background)! hover:border-(--ui-color-input-field-error)! hover:bg-(--ui-color-input-field-error-background)! focus:outline-(--color-siemens-interaction-focus-border)',
        },
      ],
      defaultVariants: {
        size: 'md',
        color: 'primary',
        variant: 'siemens',
      },
    },

    // ── InputMenu ────────────────────────────────────────────────────
    inputMenu: {
      variants: {
        variant: {
          siemens: 'border-0 border-b-1 border-(--ui-color-input-field-border) bg-(--ui-color-input-field-background) text-(--ui-text) rounded-none placeholder:text-(--ui-color-input-field-border) hover:border-(--ui-color-siemens-hover) hover:bg-(--ui-color-siemens-hover-background) active:border-(--ui-color-siemens-hover) active:bg-(--ui-color-siemens-hover-background) focus:bg-(--ui-color-siemens-hover-background) focus:outline focus:outline-solid focus:outline-offset-1 focus:outline-(--color-siemens-interaction-focus-border) disabled:bg-(--ui-color-siemens-disabled-background) disabled:text-(--ui-color-siemens-disabled-text) disabled:border-b-0 disabled:cursor-not-allowed',
        },
      },
      compoundVariants: [
        {
          color: 'error',
          variant: 'siemens',
          class: 'border-(--ui-color-input-field-error)! bg-(--ui-color-input-field-error-background)! hover:border-(--ui-color-input-field-error)! hover:bg-(--ui-color-input-field-error-background)! focus:outline-(--color-siemens-interaction-focus-border)',
        },
      ],
      defaultVariants: {
        size: 'md',
        color: 'primary',
        variant: 'siemens',
      },
    },

    // ── InputNumber ──────────────────────────────────────────────────
    inputNumber: {
      variants: {
        variant: {
          siemens: 'border-0 border-b-1 border-(--ui-color-input-field-border) bg-(--ui-color-input-field-background) text-(--ui-text) rounded-none placeholder:text-(--ui-color-input-field-border) hover:border-(--ui-color-siemens-hover) hover:bg-(--ui-color-siemens-hover-background) active:border-(--ui-color-siemens-hover) active:bg-(--ui-color-siemens-hover-background) focus:bg-(--ui-color-siemens-hover-background) focus:outline focus:outline-solid focus:outline-offset-1 focus:outline-(--color-siemens-interaction-focus-border) disabled:bg-(--ui-color-siemens-disabled-background) disabled:text-(--ui-color-siemens-disabled-text) disabled:border-b-0 disabled:cursor-not-allowed',
        },
      },
      compoundVariants: [
        {
          color: 'error',
          variant: 'siemens',
          class: 'border-(--ui-color-input-field-error)! bg-(--ui-color-input-field-error-background)! hover:border-(--ui-color-input-field-error)! hover:bg-(--ui-color-input-field-error-background)! focus:outline-(--color-siemens-interaction-focus-border)',
        },
      ],
      defaultVariants: {
        size: 'md',
        color: 'primary',
        variant: 'siemens',
      },
    },

    // ── Select ───────────────────────────────────────────────────────
    select: {
      variants: {
        variant: {
          siemens: {
            base: 'border-0 border-b-1 border-(--ui-color-input-field-border) bg-(--ui-color-input-field-background) text-(--ui-text) rounded-none placeholder:text-(--ui-color-input-field-border) hover:border-(--ui-color-siemens-hover) hover:bg-(--ui-color-siemens-hover-background) active:border-(--ui-color-siemens-hover) active:bg-(--ui-color-siemens-hover-background) focus:bg-(--ui-color-siemens-hover-background) focus:outline focus:outline-solid focus:outline-offset-1 focus:outline-(--color-siemens-interaction-focus-border) disabled:bg-(--ui-color-siemens-disabled-background) disabled:text-(--ui-color-siemens-disabled-text) disabled:border-b-0 disabled:cursor-not-allowed',
            content: 'bg-(--ui-color-alert-info) dark:bg-(--ui-bg) ring-0 border-1 border-(--color-siemens-interaction-light-teal) dark:border-(--color-siemens-primary-bold-green)',
            item: 'data-highlighted:not-data-disabled:text-(--ui-text) data-highlighted:not-data-disabled:before:bg-(--color-siemens-interaction-light-light-green) dark:data-highlighted:not-data-disabled:before:bg-(--color-siemens-interaction-light-teal)',
            group: 'p-0',
          },
        },
      },
      compoundVariants: [
        {
          color: 'error',
          variant: 'siemens',
          class: 'border-(--ui-color-input-field-error)! bg-(--ui-color-input-field-error-background)! hover:border-(--ui-color-input-field-error)! hover:bg-(--ui-color-input-field-error-background)! focus:outline-(--color-siemens-interaction-focus-border)',
        },
      ],
      defaultVariants: {
        size: 'md',
        color: 'primary',
        variant: 'siemens',
      },
    },

    // ── SelectMenu ───────────────────────────────────────────────────
    selectMenu: {
      variants: {
        variant: {
          siemens: 'border-0 border-b-1 border-(--ui-color-input-field-border) bg-(--ui-color-input-field-background) text-(--ui-text) rounded-none placeholder:text-(--ui-color-input-field-border) hover:border-(--ui-color-siemens-hover) hover:bg-(--ui-color-siemens-hover-background) active:border-(--ui-color-siemens-hover) active:bg-(--ui-color-siemens-hover-background) focus:bg-(--ui-color-siemens-hover-background) focus:outline focus:outline-solid focus:outline-offset-1 focus:outline-(--color-siemens-interaction-focus-border) disabled:bg-(--ui-color-siemens-disabled-background) disabled:text-(--ui-color-siemens-disabled-text) disabled:border-b-0 disabled:cursor-not-allowed',
        },
      },
      compoundVariants: [
        {
          color: 'error',
          variant: 'siemens',
          class: 'border-(--ui-color-input-field-error)! bg-(--ui-color-input-field-error-background)! hover:border-(--ui-color-input-field-error)! hover:bg-(--ui-color-input-field-error-background)! focus:outline-(--color-siemens-interaction-focus-border)',
        },
      ],
      defaultVariants: {
        size: 'md',
        color: 'primary',
        variant: 'siemens',
      },
    },

    // ── Textarea ─────────────────────────────────────────────────────
    textarea: {
      variants: {
        variant: {
          siemens: 'border-0 border-b-1 border-(--ui-color-input-field-border) bg-(--ui-color-input-field-background) text-(--ui-text) rounded-none placeholder:text-(--ui-color-input-field-border) hover:border-(--ui-color-siemens-hover) hover:bg-(--ui-color-siemens-hover-background) active:border-(--ui-color-siemens-hover) active:bg-(--ui-color-siemens-hover-background) focus:bg-(--ui-color-siemens-hover-background) focus:outline focus:outline-solid focus:outline-offset-1 focus:outline-(--color-siemens-interaction-focus-border) disabled:bg-(--ui-color-siemens-disabled-background) disabled:text-(--ui-color-siemens-disabled-text) disabled:border-b-0 disabled:cursor-not-allowed',
        },
      },
      compoundVariants: [
        {
          color: 'error',
          variant: 'siemens',
          class: 'border-(--ui-color-input-field-error)! bg-(--ui-color-input-field-error-background)! hover:border-(--ui-color-input-field-error)! hover:bg-(--ui-color-input-field-error-background)! focus:outline-(--color-siemens-interaction-focus-border)',
        },
      ],
      defaultVariants: {
        size: 'md',
        color: 'primary',
        variant: 'siemens',
      },
    },

    // ── Checkbox ─────────────────────────────────────────────────────
    checkbox: {
      slots: {
        base: 'rounded-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-siemens-interaction-focus-border) disabled:cursor-not-allowed',
        label: 'text-(--ui-text)',
      },
      variants: {
        color: {
          primary: {
            base: 'ring-(--ui-color-input-field-border) bg-(--ui-color-input-field-background) hover:ring-(--ui-color-siemens-hover) hover:bg-(--ui-color-siemens-hover-background) data-[state=checked]:bg-(--ui-color-siemens) data-[state=checked]:ring-(--ui-color-siemens) data-[state=checked]:hover:bg-(--ui-color-siemens-hover) data-[state=checked]:hover:ring-(--ui-color-siemens-hover) data-[state=indeterminate]:bg-(--ui-color-siemens) data-[state=indeterminate]:ring-(--ui-color-siemens) disabled:ring-(--color-siemens-secondary-deep-blue-30) disabled:bg-(--ui-color-siemens-disabled-background) data-[state=checked]:disabled:bg-(--ui-color-siemens-disabled-text) data-[state=checked]:disabled:ring-(--ui-color-siemens-disabled-text)',
          },
        },
        disabled: {
          true: {
            label: 'text-(--ui-color-siemens-disabled-text)',
          },
        },
      },
      defaultVariants: {
        color: 'primary',
        size: 'md',
      },
    },

    // ── Radio / RadioGroup ────────────────────────────────────────────
    radio: {
      slots: {
        base: 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-siemens-interaction-focus-border) disabled:cursor-not-allowed',
        label: 'text-(--ui-text)',
      },
      variants: {
        color: {
          primary: {
            base: 'ring-(--ui-color-input-field-border) bg-(--ui-color-input-field-background) hover:ring-(--ui-color-siemens-hover) hover:bg-(--ui-color-siemens-hover-background) data-[state=checked]:ring-(--ui-color-siemens) data-[state=checked]:bg-(--ui-color-siemens) data-[state=checked]:hover:ring-(--ui-color-siemens-hover) data-[state=checked]:hover:bg-(--ui-color-siemens-hover) disabled:ring-(--color-siemens-secondary-deep-blue-30) disabled:bg-(--ui-color-siemens-disabled-background) data-[state=checked]:disabled:bg-(--ui-color-siemens-disabled-text) data-[state=checked]:disabled:ring-(--ui-color-siemens-disabled-text)',
          },
        },
        disabled: {
          true: {
            label: 'text-(--ui-color-siemens-disabled-text)',
          },
        },
      },
      defaultVariants: {
        color: 'primary',
        size: 'md',
      },
    },

    // ── RadioGroup ───────────────────────────────────────────────────
    radioGroup: {
      slots: {
        fieldset: 'flex flex-col',
      },
    },

    // ── Switch / Toggle ───────────────────────────────────────────────
    switch: {
      slots: {
        base: 'rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-siemens-interaction-focus-border) disabled:cursor-not-allowed',
        thumb: 'rounded-full bg-white shadow-sm',
        label: 'text-(--ui-text)',
      },
      variants: {
        color: {
          primary: {
            base: 'bg-(--color-siemens-secondary-deep-blue-40) data-[state=checked]:bg-(--ui-color-siemens) hover:bg-(--color-siemens-secondary-deep-blue-50) data-[state=checked]:hover:bg-(--ui-color-siemens-hover) disabled:bg-(--ui-color-surface-strong-border) data-[state=checked]:disabled:bg-(--color-siemens-secondary-deep-blue-40)',
          },
        },
        disabled: {
          true: {
            label: 'text-(--ui-color-siemens-disabled-text)',
          },
        },
      },
      defaultVariants: {
        color: 'primary',
        size: 'md',
      },
    },

    // ── Slider ───────────────────────────────────────────────────────
    slider: {
      slots: {
        track: 'bg-(--ui-color-surface-border) rounded-none',
        range: 'bg-(--ui-color-siemens) rounded-none',
        thumb: 'bg-white border-2 border-(--ui-color-siemens) rounded-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-siemens-interaction-focus-border) hover:border-(--ui-color-siemens-hover)',
      },
      variants: {
        color: {
          primary: {
            range: 'bg-(--ui-color-siemens)',
            thumb: 'border-(--ui-color-siemens) focus-visible:ring-4 focus-visible:ring-(--color-siemens-interaction-light-focus-blue-20)',
          },
        },
        disabled: {
          true: {
            range: 'bg-(--ui-color-siemens-disabled-text)',
            thumb: 'border-(--ui-color-siemens-disabled-text) cursor-not-allowed',
          },
        },
      },
      defaultVariants: {
        color: 'primary',
        size: 'md',
      },
    },

    // ── Badge ─────────────────────────────────────────────────────────
    badge: {
      slots: {
        base: 'rounded-none font-normal',
      },
      variants: {
        color: {
          primary: {

          },
        },
        variant: {
          solid: 'rounded-none',
          outline: 'rounded-none',
          soft: 'rounded-none',
          subtle: 'rounded-none',
        },
      },
      compoundVariants: [
        { color: 'primary', variant: 'solid', class: 'bg-(--ui-color-siemens) text-white' },
        { color: 'primary', variant: 'outline', class: 'border border-(--ui-color-siemens) text-(--ui-color-siemens) bg-transparent' },
        { color: 'primary', variant: 'soft', class: 'bg-(--ui-color-siemens-hover-background) text-(--ui-color-siemens)' },
        { color: 'primary', variant: 'subtle', class: 'bg-(--ui-color-siemens-hover-background) border border-(--ui-color-siemens)/30 text-(--ui-color-siemens)' },
      ],
      defaultVariants: {
        color: 'primary',
        variant: 'solid',
        size: 'md',
      },
    },

    // ── Alert ─────────────────────────────────────────────────────────
    alert: {
      slots: {
        root: 'rounded-none border-l-4',
      },
      variants: {
        color: {
          primary: {
            root: 'bg-(--ui-color-siemens-hover-background) border-l-(--ui-color-siemens)',
            title: 'text-(--ui-color-siemens)',
            icon: 'text-(--ui-color-siemens)',
          },
          info: {
            root: 'bg-(--ui-color-alert-info) border-l-(--ui-color-feedback-blue)',
            title: 'text-(--ui-color-feedback-blue)',
            icon: 'text-(--ui-color-feedback-blue)',
          },
          success: {
            root: 'bg-(--ui-color-alert-success) border-l-(--ui-color-feedback-green)',
            title: 'text-(--ui-color-feedback-green)',
            icon: 'text-(--ui-color-feedback-green)',
          },
          warning: {
            root: 'bg-(--ui-color-alert-warning) border-l-(--ui-color-feedback-yellow)',
            title: 'text-(--ui-text)',
            icon: 'text-(--ui-color-feedback-yellow)',
          },
          error: {
            root: 'bg-(--ui-color-alert-error) border-l-(--ui-color-feedback-red)',
            title: 'text-(--ui-color-feedback-red)',
            icon: 'text-(--ui-color-feedback-red)',
          },
        },
      },
      defaultVariants: {
        color: 'primary',
      },
    },

    // ── Toast ─────────────────────────────────────────────────────────
    toast: {
      slots: {
        root: 'rounded-none border-l-4',
      },
      variants: {
        color: {
          primary: {
            root: 'bg-(--ui-color-surface) border-l-(--ui-color-siemens)',
            title: 'text-(--ui-text)',
            description: 'text-(--ui-color-text-muted)',
            icon: 'text-(--ui-color-siemens)',
          },
          info: {
            root: 'bg-(--ui-color-surface) border-l-(--ui-color-feedback-blue)',
            icon: 'text-(--ui-color-feedback-blue)',
          },
          success: {
            root: 'bg-(--ui-color-surface) border-l-(--ui-color-feedback-green)',
            icon: 'text-(--ui-color-feedback-green)',
          },
          warning: {
            root: 'bg-(--ui-color-surface) border-l-(--ui-color-feedback-yellow)',
            icon: 'text-(--ui-color-feedback-orange)',
          },
          error: {
            root: 'bg-(--ui-color-surface) border-l-(--ui-color-feedback-red)',
            icon: 'text-(--ui-color-feedback-red)',
          },
        },
      },
    },

    // ── Link ──────────────────────────────────────────────────────────
    link: {
      base: 'text-(--ui-color-siemens) underline-offset-2 hover:text-(--ui-color-siemens-hover) hover:underline active:text-(--ui-color-siemens-active) focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-siemens-interaction-focus-border)',
      variants: {
        active: {
          true: 'text-(--ui-color-siemens-active) underline',
          // Nuxt UI setzt inaktive Links sonst auf text-muted
          false: 'text-(--ui-color-siemens)',
        },
        disabled: {
          true: 'text-(--ui-color-siemens-disabled-text) cursor-not-allowed no-underline!',
        },
      },
    },

    // ── Card ──────────────────────────────────────────────────────────
    card: {
      slots: {
        root: 'rounded-none border border-(--ui-color-surface-border) bg-(--ui-color-surface)',
        header: 'border-b border-(--ui-color-surface-border)',
        footer: 'border-t border-(--ui-color-surface-border)',
      },
    },

    // ── Modal / Dialog ────────────────────────────────────────────────
    modal: {
      slots: {
        content: 'rounded-none',
        // Kopf und Fuß behalten ihre Höhe; bei wenig Platz (Handy) rollt nur der Inhalt, statt dass eine lange
        // Beschreibung aus dem gestauchten Kopf läuft
        header: 'shrink-0 border-b border-(--ui-color-surface-border)',
        // Platz für das Schließen-Kreuz (absolut oben rechts), sonst läuft eine lange Beschreibung darunter
        wrapper: 'pe-8',
        footer: 'shrink-0 border-t border-(--ui-color-surface-border)',
        title: 'text-(--ui-text) font-semibold',
        close: 'rounded-none',
      },
    },

    // ── Drawer / Slideover ────────────────────────────────────────────
    drawer: {
      slots: {
        content: 'rounded-none',
        // Kopf und Fuß behalten ihre Höhe; bei wenig Platz (Handy) rollt nur der Inhalt, statt dass eine lange
        // Beschreibung aus dem gestauchten Kopf läuft
        header: 'shrink-0 border-b border-(--ui-color-surface-border)',
        footer: 'shrink-0 border-t border-(--ui-color-surface-border)',
        title: 'text-(--ui-text) font-semibold',
        close: 'rounded-none',
      },
    },

    slideover: {
      slots: {
        content: 'rounded-none',
        // Kopf und Fuß behalten ihre Höhe; bei wenig Platz (Handy) rollt nur der Inhalt, statt dass eine lange
        // Beschreibung aus dem gestauchten Kopf läuft
        header: 'shrink-0 border-b border-(--ui-color-surface-border)',
        footer: 'shrink-0 border-t border-(--ui-color-surface-border)',
        title: 'text-(--ui-text) font-semibold',
        close: 'rounded-none',
      },
    },

    // ── Tabs ──────────────────────────────────────────────────────────
    tabs: {
      slots: {
        root: 'border-b border-(--ui-color-surface-border)',
        list: 'bg-transparent border-b-0 gap-0 rounded-none p-0',
        trigger: 'rounded-none px-4 py-2 text-sm text-(--ui-color-text-muted) border-b-2 border-transparent data-[state=active]:border-(--ui-color-siemens) data-[state=active]:text-(--ui-color-siemens) hover:text-(--ui-color-siemens-hover) hover:bg-(--ui-color-siemens-hover-background) focus-visible:outline focus-visible:outline-2 focus-visible:outline-(--color-siemens-interaction-focus-border) disabled:text-(--ui-color-siemens-disabled-text) disabled:cursor-not-allowed',
        indicator: 'bg-(--ui-color-siemens) rounded-none h-0.5',
        content: 'rounded-none',
      },
    },

    // ── NavigationMenu ────────────────────────────────────────────────
    navigationMenu: {
      slots: {
        root: 'rounded-none',
        list: 'gap-0',
        link: 'rounded-none px-3 py-2 text-sm text-(--ui-color-text-muted) hover:bg-(--ui-color-siemens-hover-background) hover:text-(--ui-color-siemens-hover) data-[active]:text-(--ui-color-siemens) data-[active]:bg-(--ui-color-siemens-hover-background) focus-visible:outline focus-visible:outline-2 focus-visible:outline-(--color-siemens-interaction-focus-border)',
        childLink: 'rounded-none px-3 py-2 text-sm text-(--ui-color-text-muted) hover:bg-(--ui-color-siemens-hover-background) hover:text-(--ui-color-siemens-hover) focus-visible:outline focus-visible:outline-2 focus-visible:outline-(--color-siemens-interaction-focus-border)',
        content: 'rounded-none border border-(--ui-color-surface-border) bg-(--ui-color-surface)',
      },
    },

    // ── Breadcrumb ────────────────────────────────────────────────────
    breadcrumb: {
      slots: {
        root: 'flex items-center',
        item: 'text-sm text-(--ui-color-text-muted)',
        link: 'text-(--ui-color-siemens) hover:text-(--ui-color-siemens-hover) hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-(--color-siemens-interaction-focus-border)',
        separator: 'text-(--ui-color-text-faint) mx-1',
        ellipsis: 'text-(--ui-color-text-faint)',
      },
    },

    // ── Pagination ────────────────────────────────────────────────────
    pagination: {
      slots: {
        root: 'flex items-center gap-1',
        ellipsis: 'rounded-none text-(--ui-color-text-muted)',
      },
      variants: {
        active: {
          true: {
            item: 'bg-(--ui-color-siemens) text-white rounded-none',
          },
          false: {
            item: 'rounded-none text-(--ui-color-text-muted) hover:bg-(--ui-color-siemens-hover-background) hover:text-(--ui-color-siemens-hover)',
          },
        },
      },
    },

    // ── Table ─────────────────────────────────────────────────────────
    table: {
      slots: {
        root: 'w-full',
        thead: 'border-b border-(--ui-color-surface-strong-border)',
        tbody: 'divide-y divide-(--ui-color-surface-border)',
        tr: 'hover:bg-(--ui-color-row-hover) data-[selected=true]:bg-(--ui-color-siemens-hover-background)',
        th: 'text-left text-xs font-semibold text-(--ui-color-text-muted) uppercase tracking-wider px-3 py-3.5',
        td: 'px-3 py-3 text-sm text-(--ui-text)',
      },
    },

    // ── DropdownMenu ──────────────────────────────────────────────────
    dropdownMenu: {
      slots: {
        content: 'rounded-none border border-(--ui-color-surface-border) bg-(--ui-color-surface) shadow-lg',
        item: 'rounded-none text-sm text-(--ui-text) cursor-pointer hover:bg-(--ui-color-siemens-hover-background) hover:text-(--ui-color-siemens-hover) data-[highlighted]:bg-(--ui-color-siemens-hover-background) data-[highlighted]:text-(--ui-color-siemens-hover) focus-visible:outline-none',
        separator: 'bg-(--ui-color-surface-border)',
        label: 'text-xs text-(--ui-color-text-subtle) font-medium uppercase tracking-wider',
      },
    },

    // ── ContextMenu ───────────────────────────────────────────────────
    contextMenu: {
      slots: {
        content: 'rounded-none border border-(--ui-color-surface-border) bg-(--ui-color-surface) shadow-lg',
        item: 'rounded-none text-sm text-(--ui-text) cursor-pointer hover:bg-(--ui-color-siemens-hover-background) hover:text-(--ui-color-siemens-hover) data-[highlighted]:bg-(--ui-color-siemens-hover-background) data-[highlighted]:text-(--ui-color-siemens-hover) focus-visible:outline-none',
        separator: 'bg-(--ui-color-surface-border)',
      },
    },

    // ── Popover ───────────────────────────────────────────────────────
    popover: {
      slots: {
        content: 'rounded-none border border-(--ui-color-surface-border) bg-(--ui-color-surface) shadow-lg',
      },
    },

    // ── Tooltip ───────────────────────────────────────────────────────
    tooltip: {
      slots: {
        content: 'rounded-none bg-(--color-siemens-primary-deep-blue) text-white text-xs px-2 py-1',
        arrow: 'fill-(--color-siemens-primary-deep-blue)',
      },
    },

    // ── Avatar ────────────────────────────────────────────────────────
    avatar: {
      slots: {
        root: 'rounded-none bg-(--ui-color-surface-border) text-(--ui-color-siemens)',
        fallback: 'font-medium',
      },
    },

    // ── Progress ──────────────────────────────────────────────────────
    progress: {
      slots: {
        root: 'rounded-none',
        track: 'bg-(--ui-color-surface-border) rounded-none overflow-hidden',
        indicator: 'bg-(--ui-color-siemens) rounded-none transition-all',
      },
      variants: {
        color: {
          primary: {
            indicator: 'bg-(--ui-color-siemens)',
          },
          success: {
            indicator: 'bg-(--ui-color-feedback-green)',
          },
          warning: {
            indicator: 'bg-(--ui-color-feedback-orange)',
          },
          error: {
            indicator: 'bg-(--ui-color-feedback-red)',
          },
        },
      },
    },

    // ── Accordion ─────────────────────────────────────────────────────
    accordion: {
      slots: {
        root: 'divide-y divide-(--ui-color-surface-border)',
        item: 'border-b border-(--ui-color-surface-border) last:border-b-0',
        trigger: 'w-full flex items-center justify-between py-3 text-sm font-medium text-(--ui-text) hover:text-(--ui-color-siemens) focus-visible:outline focus-visible:outline-2 focus-visible:outline-(--color-siemens-interaction-focus-border)',
        content: 'text-sm text-(--ui-color-text-muted) pb-3',
      },
    },

    // ── Separator ─────────────────────────────────────────────────────
    separator: {
      slots: {
        root: 'border-(--ui-color-surface-border)',
      },
    },

    // ── Chip ──────────────────────────────────────────────────────────
    chip: {
      slots: {
        base: 'rounded-none',
      },
      variants: {
        color: {
          primary: {
            base: 'bg-(--ui-color-siemens)',
          },
          success: {
            base: 'bg-(--ui-color-feedback-green)',
          },
          warning: {
            base: 'bg-(--ui-color-feedback-orange)',
          },
          error: {
            base: 'bg-(--ui-color-feedback-red)',
          },
        },
      },
    },

    // ── CommandPalette ────────────────────────────────────────────────
    commandPalette: {
      slots: {
        root: 'rounded-none',
        input: 'rounded-none border-b border-(--ui-color-surface-border) bg-transparent text-(--ui-text) placeholder:text-(--ui-color-text-subtle) focus:outline-none',
        group: '',
        groupLabel: 'text-xs text-(--ui-color-text-subtle) uppercase tracking-wider font-medium px-3 py-2',
        item: 'rounded-none text-sm text-(--ui-text) cursor-pointer hover:bg-(--ui-color-siemens-hover-background) hover:text-(--ui-color-siemens-hover) data-[highlighted]:bg-(--ui-color-siemens-hover-background) data-[highlighted]:text-(--ui-color-siemens-hover) px-3 py-2',
        itemLeadingIcon: 'text-(--ui-color-text-subtle)',
        empty: 'text-sm text-(--ui-color-text-subtle) py-6 text-center',
      },
    },

    // ── PinInput ──────────────────────────────────────────────────────
    pinInput: {
      slots: {
        root: 'flex items-center gap-2',
        base: 'rounded-none border border-(--ui-color-input-field-border) bg-(--ui-color-input-field-background) text-(--ui-text) text-center focus:outline focus:outline-solid focus:outline-offset-1 focus:outline-(--color-siemens-interaction-focus-border) focus:border-(--ui-color-siemens-hover) focus:bg-(--ui-color-siemens-hover-background)',
      },
    },

    // ── Skeleton ──────────────────────────────────────────────────────
    skeleton: {
      base: 'rounded-none animate-pulse bg-(--ui-color-surface-border)',
    },
  },
})
