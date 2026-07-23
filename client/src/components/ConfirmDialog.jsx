import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '#/components/ui/dialog';
import { Button } from '#/components/ui/button';

/**
 * Reusable confirm dialog replacing window.confirm() for destructive actions.
 * Props:
 *   open       boolean
 *   onClose    () => void
 *   onConfirm  () => void
 *   title      string
 *   description string
 *   confirmLabel string  (default '确认')
 *   destructive  boolean (default false) — styles confirm button as destructive
 */
export default function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title = '确认操作',
  description,
  confirmLabel = '确认',
  destructive = false,
}) {
  const handleConfirm = () => {
    onClose();
    onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>取消</Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
