import { createAttachment, removeAttachment } from '../services/attachmentService.js';

export async function uploadAttachment(req, res, next) {
  try {
    const attachment = await createAttachment({ userId: req.user.id, file: req.file });

    res.status(201).json({ attachment });
  } catch (error) {
    next(error);
  }
}

export async function deleteAttachment(req, res, next) {
  try {
    // req.resource is the row requireOwnership loaded; the check is already done.
    await removeAttachment(req.resource);

    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
