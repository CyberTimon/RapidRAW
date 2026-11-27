import type { ComponentProps, ElementType } from 'react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import Text from './Text';
import { TextColors, TextVariants } from '../../types/typography';

type ToolTileProps = Omit<ComponentProps<typeof motion.div>, 'className' | 'children'> & {
  icon: ElementType;
  label: string;
  disabled?: boolean;
  dragging?: boolean;
};

export function ToolTileOverlay({ icon: Icon, label }: { icon: ElementType; label: string }) {
  return (
    <Text
      as="div"
      variant={TextVariants.small}
      color={TextColors.primary}
      className="bg-surface rounded-lg gap-2 p-2 flex flex-col items-center justify-center aspect-square w-20 shadow-xl opacity-90"
    >
      <Icon size={24} />
      <span className="text-center">{label}</span>
    </Text>
  );
}

export default function ToolTile({ icon: Icon, label, disabled = false, dragging = false, ...props }: ToolTileProps) {
  return (
    <motion.div
      {...props}
      className={clsx(
        'bg-surface text-text-primary rounded-lg p-2 flex flex-col items-center justify-center gap-2 aspect-square transition-colors',
        disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-card-active active:bg-accent/20',
        dragging && 'opacity-50',
      )}
      whileTap={{ scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 400, damping: 17 }}
    >
      <Icon size={24} />
      <Text
        as="span"
        variant={TextVariants.small}
        color={TextColors.primary}
        className="text-center w-full leading-tight"
      >
        {label}
      </Text>
    </motion.div>
  );
}
