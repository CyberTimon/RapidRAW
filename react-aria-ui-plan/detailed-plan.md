# React Aria Migration - Detailed Plan

## Phase 1: Foundation Setup

### 1.1 Install Dependencies

```bash
npm install react-aria-components
npm install @react-aria/optimize-locales-plugin --save-dev
```

### 1.2 Configure Vite

Update `vite.config.ts` to optimize locale bundles:

```typescript
import optimizeLocales from '@react-aria/optimize-locales-plugin';

export default defineConfig({
  plugins: [
    {
      ...optimizeLocales.vite({
        locales: ['en-US'] // Add more as needed
      }),
      enforce: 'pre'
    },
    // ... existing plugins
  ],
});
```

### 1.3 Create Provider Wrapper

Create `src/providers/AriaProvider.tsx`:

```typescript
import { RouterProvider } from 'react-aria-components';
import { useNavigate } from 'react-router-dom'; // if using router

export function AriaProvider({ children }: { children: React.ReactNode }) {
  // Configure router integration if needed
  return (
    <RouterProvider navigate={navigate}>
      {children}
    </RouterProvider>
  );
}
```

### 1.4 Create Shared Utilities

Create `src/primitives/aria-utils.ts`:

```typescript
import { composeRenderProps } from 'react-aria-components';

// Compose Tailwind classes with React Aria render props
export function composeTailwindRenderProps<T>(
  className: string | ((renderProps: T) => string) | undefined,
  defaultClassName: string
): string | ((renderProps: T) => string) {
  return composeRenderProps(className, (className) => 
    `${defaultClassName} ${className ?? ''}`
  );
}

// Focus ring styles
export const focusRing = `
  outline-none
  focus-visible:ring-2
  focus-visible:ring-accent
  focus-visible:ring-offset-2
  focus-visible:ring-offset-bg-primary
`;
```

---

## Phase 2: Core Primitives Migration

### 2.1 Button Migration

**Current API:**
```typescript
interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'surface' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';
  disabled?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}
```

**New Implementation (`src/primitives/Button.tsx`):**

```typescript
import { Button as AriaButton, ButtonProps as AriaButtonProps } from 'react-aria-components';
import { tv } from 'tailwind-variants'; // optional, for variant management

const buttonStyles = tv({
  base: 'flex items-center justify-center gap-2 font-semibold rounded-md transition-colors',
  variants: {
    variant: {
      primary: 'bg-accent text-button-text shadow-shiny pressed:bg-accent/90',
      secondary: 'bg-surface text-text-primary border border-border-color hover:bg-bg-tertiary',
      surface: 'bg-surface text-text-primary',
      ghost: 'bg-transparent text-text-primary hover:bg-surface',
      destructive: 'bg-red-600 text-white pressed:bg-red-700',
    },
    size: {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-4 py-2 text-sm',
      lg: 'px-6 py-3 text-base',
      icon: 'p-2',
      'icon-sm': 'p-1.5',
    },
    isDisabled: {
      true: 'opacity-50 cursor-not-allowed shadow-none',
    },
  },
  defaultVariants: {
    variant: 'primary',
    size: 'md',
  },
});

export interface ButtonProps extends Omit<AriaButtonProps, 'className'> {
  variant?: 'primary' | 'secondary' | 'surface' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';
  className?: string;
}

export function Button({ variant, size, className, ...props }: ButtonProps) {
  return (
    <AriaButton
      {...props}
      className={({ isDisabled, isPressed, isFocusVisible }) =>
        buttonStyles({ variant, size, isDisabled, className })
      }
    />
  );
}
```

### 2.2 Select/Dropdown Migration

**Current API:**
```typescript
interface DropdownProps<T> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
}
```

**New Implementation (`src/primitives/Select.tsx`):**

```typescript
import {
  Select as AriaSelect,
  SelectProps as AriaSelectProps,
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  SelectValue,
} from 'react-aria-components';
import { ChevronDown, Check } from 'lucide-react';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string = string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
  className?: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = 'Select an option',
  disabled = false,
  label,
  className,
}: SelectProps<T>) {
  return (
    <AriaSelect
      selectedKey={value}
      onSelectionChange={(key) => onChange(key as T)}
      isDisabled={disabled}
      className={`relative ${className}`}
    >
      {label && <Label className="text-sm text-text-secondary mb-1">{label}</Label>}
      
      <Button className="w-full bg-bg-primary border border-border-color rounded-md px-3 py-2 flex justify-between items-center focus:ring-2 focus:ring-accent focus:border-accent focus:outline-none disabled:opacity-50">
        <SelectValue className="text-text-primary">
          {({ selectedText }) => selectedText || placeholder}
        </SelectValue>
        <ChevronDown className="text-text-secondary w-5 h-5" />
      </Button>
      
      <Popover className="w-[--trigger-width] bg-surface/95 backdrop-blur-md rounded-lg shadow-xl p-2 max-h-80 overflow-y-auto entering:animate-in entering:fade-in exiting:animate-out exiting:fade-out">
        <ListBox className="outline-none">
          {options.map((option) => (
            <ListBoxItem
              key={option.value}
              id={option.value}
              textValue={option.label}
              className="w-full text-left px-3 py-2 text-sm rounded-md flex items-center justify-between cursor-pointer text-text-primary hover:bg-bg-primary focus:bg-bg-primary selected:bg-bg-primary selected:font-semibold outline-none"
            >
              {({ isSelected }) => (
                <>
                  <span>{option.label}</span>
                  {isSelected && <Check className="w-4 h-4" />}
                </>
              )}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

// Backward compatibility alias
export { Select as Dropdown };
export type { SelectOption as DropdownOption };
```

### 2.3 Modal/Dialog Migration

**New Implementation (`src/primitives/Modal.tsx`):**

```typescript
import {
  Dialog,
  DialogTrigger,
  Modal as AriaModal,
  ModalOverlay,
  Heading,
} from 'react-aria-components';
import { Button } from './Button';

type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

const sizeClasses: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  full: 'max-w-4xl',
};

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  size?: ModalSize;
  showCloseButton?: boolean;
  isDismissable?: boolean;
  footer?: React.ReactNode;
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
  showCloseButton = true,
  isDismissable = true,
  footer,
}: ModalProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={isDismissable}
      className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center entering:animate-in entering:fade-in exiting:animate-out exiting:fade-out"
    >
      <AriaModal className={`bg-surface rounded-lg shadow-xl p-6 w-full ${sizeClasses[size]} max-h-[90vh] flex flex-col outline-none entering:animate-in entering:zoom-in-95 exiting:animate-out exiting:zoom-out-95`}>
        <Dialog className="outline-none flex-1 flex flex-col">
          {({ close }) => (
            <>
              {(title || showCloseButton) && (
                <div className="flex items-center justify-between mb-4">
                  {title && (
                    <Heading slot="title" className="text-lg font-semibold text-text-primary">
                      {title}
                    </Heading>
                  )}
                  {showCloseButton && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onPress={close}
                      aria-label="Close modal"
                    >
                      <XIcon className="w-5 h-5" />
                    </Button>
                  )}
                </div>
              )}
              <div className="flex-1 overflow-y-auto">{children}</div>
              {footer && <div className="flex justify-end gap-3 mt-5">{footer}</div>}
            </>
          )}
        </Dialog>
      </AriaModal>
    </ModalOverlay>
  );
}
```

### 2.4 Switch Migration

**New Implementation (`src/primitives/Switch.tsx`):**

```typescript
import { Switch as AriaSwitch, SwitchProps as AriaSwitchProps } from 'react-aria-components';

interface SwitchProps extends Omit<AriaSwitchProps, 'children'> {
  label?: string;
}

export function Switch({ label, className, ...props }: SwitchProps) {
  return (
    <AriaSwitch
      {...props}
      className={`group flex items-center gap-2 ${className}`}
    >
      <div className="w-9 h-5 bg-card-active rounded-full transition-colors group-selected:bg-accent group-disabled:opacity-50">
        <div className="w-4 h-4 bg-white rounded-full shadow transition-transform translate-x-0.5 group-selected:translate-x-[18px] mt-0.5" />
      </div>
      {label && <span className="text-sm text-text-primary">{label}</span>}
    </AriaSwitch>
  );
}
```

### 2.5 TextField/Input Migration

**New Implementation (`src/primitives/Input.tsx`):**

```typescript
import {
  TextField,
  Label,
  Input as AriaInput,
  FieldError,
  Text,
} from 'react-aria-components';

interface InputProps {
  label?: string;
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  type?: 'text' | 'email' | 'password' | 'number';
  disabled?: boolean;
  error?: string;
  description?: string;
  className?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export function Input({
  label,
  placeholder,
  value,
  onChange,
  type = 'text',
  disabled = false,
  error,
  description,
  className,
  leftIcon,
  rightIcon,
}: InputProps) {
  return (
    <TextField
      value={value}
      onChange={onChange}
      isDisabled={disabled}
      isInvalid={!!error}
      className={`flex flex-col gap-1 ${className}`}
    >
      {label && <Label className="text-sm font-medium text-text-secondary">{label}</Label>}
      
      <div className="relative">
        {leftIcon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary">
            {leftIcon}
          </div>
        )}
        
        <AriaInput
          type={type}
          placeholder={placeholder}
          className={`w-full px-3 py-2 bg-bg-primary border border-border-color rounded-md text-text-primary placeholder-text-secondary focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent disabled:opacity-50 invalid:border-red-500 ${leftIcon ? 'pl-10' : ''} ${rightIcon ? 'pr-10' : ''}`}
        />
        
        {rightIcon && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary">
            {rightIcon}
          </div>
        )}
      </div>
      
      {description && !error && (
        <Text slot="description" className="text-xs text-text-secondary">
          {description}
        </Text>
      )}
      
      {error && (
        <FieldError className="text-xs text-red-500">{error}</FieldError>
      )}
    </TextField>
  );
}
```

---

## Phase 3: Advanced Components

### 3.1 CollapsibleSection → Disclosure

```typescript
import { Disclosure, DisclosurePanel, Button, Heading } from 'react-aria-components';
import { ChevronRight } from 'lucide-react';

interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  defaultExpanded?: boolean;
}

export function CollapsibleSection({ title, children, defaultExpanded = false }: CollapsibleSectionProps) {
  return (
    <Disclosure defaultExpanded={defaultExpanded}>
      {({ isExpanded }) => (
        <>
          <Heading>
            <Button
              slot="trigger"
              className="flex items-center gap-2 w-full py-2 text-left text-text-primary hover:bg-surface rounded"
            >
              <ChevronRight className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
              <span className="font-medium">{title}</span>
            </Button>
          </Heading>
          <DisclosurePanel className="pl-6 py-2">
            {children}
          </DisclosurePanel>
        </>
      )}
    </Disclosure>
  );
}
```

### 3.2 Context Menu → Menu

```typescript
import {
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Separator,
} from 'react-aria-components';

interface ContextMenuProps {
  trigger: React.ReactNode;
  items: Array<{
    id: string;
    label: string;
    icon?: React.ReactNode;
    onAction?: () => void;
    separator?: boolean;
  }>;
}

export function ContextMenu({ trigger, items }: ContextMenuProps) {
  return (
    <MenuTrigger>
      {trigger}
      <Popover className="bg-surface/95 backdrop-blur-md rounded-lg shadow-xl p-1 min-w-[160px]">
        <Menu className="outline-none" onAction={(key) => {
          const item = items.find(i => i.id === key);
          item?.onAction?.();
        }}>
          {items.map((item) => 
            item.separator ? (
              <Separator key={item.id} className="my-1 border-t border-border-color" />
            ) : (
              <MenuItem
                key={item.id}
                id={item.id}
                className="flex items-center gap-2 px-3 py-2 text-sm rounded cursor-pointer text-text-primary hover:bg-bg-primary focus:bg-bg-primary outline-none"
              >
                {item.icon}
                {item.label}
              </MenuItem>
            )
          )}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
```

### 3.3 Tooltip

```typescript
import { Tooltip as AriaTooltip, TooltipTrigger, Button } from 'react-aria-components';

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

export function Tooltip({ content, children, placement = 'top' }: TooltipProps) {
  return (
    <TooltipTrigger delay={300}>
      {children}
      <AriaTooltip
        placement={placement}
        className="bg-surface text-text-primary text-sm px-2 py-1 rounded shadow-lg entering:animate-in entering:fade-in exiting:animate-out exiting:fade-out"
      >
        {content}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
```

---

## Phase 4: Specialized Components

### 4.1 Slider (Hybrid Approach)

Keep the custom slider but enhance with React Aria hooks for accessibility:

```typescript
import { useSlider, useSliderThumb } from 'react-aria';
import { useSliderState } from 'react-stately';
// ... integrate hooks into existing Slider component
```

### 4.2 ColorWheel Evaluation

Options:
1. Keep `@uiw/react-color-wheel` (current)
2. Migrate to React Aria's `ColorWheel` from `@react-spectrum/color`
3. Build custom with React Aria color hooks

Recommendation: Evaluate React Aria's ColorWheel first, as it has full accessibility built-in.

---

## Phase 5: Cleanup & Documentation

1. Remove old component implementations
2. Update all imports across the codebase
3. Run accessibility audit
4. Update component documentation
5. Create migration guide for any API changes
