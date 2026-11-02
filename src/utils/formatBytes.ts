export const formatBytes = (bytes: number, t: any, decimals = 2) => {
  if (!+bytes) return `0 ${t('export.bytes.bytes')}`;
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = [
    t('export.bytes.bytes'),
    t('export.bytes.kb'),
    t('export.bytes.mb'),
    t('export.bytes.gb'),
    t('export.bytes.tb'),
  ];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};
