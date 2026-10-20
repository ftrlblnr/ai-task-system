-- Приёмная: ответ без встречи (текст/голос) и «разберитесь сами».
ALTER TYPE "ReceptionRequestStatus" ADD VALUE 'ANSWERED';
ALTER TYPE "ReceptionRequestStatus" ADD VALUE 'DELEGATED';
ALTER TYPE "ReceptionEventType" ADD VALUE 'ANSWERED';
ALTER TYPE "ReceptionEventType" ADD VALUE 'DELEGATED';
ALTER TYPE "ReceptionNotificationKind" ADD VALUE 'ANSWERED';
ALTER TYPE "ReceptionNotificationKind" ADD VALUE 'DELEGATED';
