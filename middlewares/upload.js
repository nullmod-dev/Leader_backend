/**
 * Multipart image upload (memory only — the file reaches disk only after
 * sharp re-encodes it in storageService.saveImage).
 *
 * Usage:  router.post('/:id/image', imageUpload('image'), controller.setImage)
 * The controller reads `req.file.buffer`. Field name is `image` by default.
 */
const multer = require('multer');
const config = require('../config');
const AppError = require('../utils/appError');

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];

const uploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) return cb(null, true);
    return cb(AppError.validation({ [file.fieldname]: 'Only JPEG, PNG, WebP, GIF or HEIC images are accepted.' }));
  },
});

const imageUpload = (field = 'image', { required = true } = {}) => (req, res, next) => {
  uploader.single(field)(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError('payload_too_large', 413, `The image exceeds ${Math.round(config.maxUploadBytes / 1048576)} MB.`));
        }
        return next(AppError.validation({ [field]: err.message }));
      }
      return next(err);
    }
    if (required && !req.file) return next(AppError.validation({ [field]: `Attach an image in the "${field}" form field.` }));
    return next();
  });
};

module.exports = { imageUpload };
