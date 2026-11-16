/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { blobUrl } from "../../lib/api";
import type { CharacterImage, CharacterRef } from "../../lib/api-characters";
import {
  deleteCharacterImage,
  getCharacter,
  listImages,
  setCharacterImage,
  uploadImage,
} from "../../lib/api-characters";
import { cx } from "../../lib/cx";
import { INSTANT, riseVariants, useAppMotion } from "../../lib/motion";
import { ChevronLeft, ChevronRight, Image, Star, Trash2, Upload } from "../ui/icons";
import { Presence } from "../ui/presence";
import ImageLightbox from "./ImageLightbox";
import "../../styles/characters.css";

interface GalleryPanelProps {
  character: CharacterRef;
  /** Fired after any successful mutation (upload / avatar / delete / reorder). */
  onChanged: () => void;
}

/** Placeholder tiles while the first gallery fetch settles. */
const GALLERY_SKELETONS = Array.from({ length: 4 }, (_, i) => i);

/** Inline gallery: upload images (pick or drop), pick the avatar, reorder, and
 *  delete. Every mutation still goes through the same API calls as before —
 *  only the surfaces around them are new. */
export default function GalleryPanel(props: GalleryPanelProps) {
  const { character, onChanged } = props;
  const app = useAppMotion();
  const [images, setImages] = useState<CharacterImage[]>([]);
  // Captured once at setup (the Solid signal's lazy initial value): a parent
  // re-render must never clobber the avatar path the gallery has loaded.
  const [avatarPath, setAvatarPath] = useState<string | null>(() => character.avatar_path);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // True until the first list/full-card fetch settles. The gallery used to
  // render its "No images yet" empty state on first paint, flashing the wrong
  // message before the list resolved; the skeleton stands in instead.
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  /** The image open in the full-screen viewer, or null when closed. */
  const [preview, setPreview] = useState<CharacterImage | null>(null);

  const isAvatar = (image: CharacterImage): boolean =>
    avatarPath !== null && avatarPath === image.blob_path;

  const reload = useCallback((): void => {
    Promise.all([listImages(character.id), getCharacter(character.id)])
      .then(([list, loaded]) => {
        setImages(list);
        setAvatarPath(loaded.avatar_path);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load gallery");
      })
      .finally(() => setLoading(false));
  }, [character.id]);
  useEffect(() => {
    reload();
  }, [reload]);

  const run = (action: () => Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    action()
      .then(() => {
        reload();
        onChanged();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Gallery action failed");
      })
      .finally(() => setBusy(false));
  };

  /** Uploads every picked/dropped file sequentially, then reloads once. A
   *  single-file pick is just a one-item list, so the old behaviour holds. */
  const uploadFiles = (files: File[]): void => {
    const list = files.filter((file) => file.size > 0);
    if (list.length === 0) {
      return;
    }
    run(async () => {
      for (const file of list) {
        await uploadImage(character.id, file);
      }
    });
  };

  /** Moves an image one slot and persists the new order. `sort` is the only
   *  ordering column, so the whole visible order is re-indexed — cheap for a
   *  gallery and immune to duplicate sort values left by uploads/deletes. */
  const moveImage = (index: number, delta: number): void => {
    const target = index + delta;
    if (target < 0 || target >= images.length) {
      return;
    }
    const next = images.slice();
    const [moved] = next.splice(index, 1);
    if (moved === undefined) {
      return;
    }
    next.splice(target, 0, moved);
    run(async () => {
      for (let i = 0; i < next.length; i += 1) {
        const image = next[i];
        if (image !== undefined && image.sort !== i) {
          await setCharacterImage(character.id, image.id, { sort: i });
        }
      }
    });
  };

  const previewUrl = preview === null ? null : blobUrl(preview.blob_path);

  return (
    <div className="stack">
      {/* The picker doubles as the dropzone: dragging anywhere on it is a valid
          image drop, and the click target still opens the file dialog. */}
      <label
        className={cx("char-dropzone", dragOver && "is-over")}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(event) => {
          // Ignore the transient leave fired when the drag crosses into a child.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragOver(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          const files = event.dataTransfer?.files;
          if (files !== undefined && files !== null) {
            uploadFiles(Array.from(files));
          }
        }}
      >
        <motion.span
          className="char-dropzone-icon"
          aria-hidden="true"
          // Motivated motion: the icon lifts a touch while a drag hovers, so the
          // drop target itself responds. Holds still under reduced motion.
          animate={{ scale: dragOver && !app.reduce ? 1.08 : 1 }}
          transition={app.reduce ? INSTANT : app.spring.snappy}
        >
          <Upload size={20} />
        </motion.span>
        <span className="caption">Drag &amp; drop or click to upload</span>
        <input
          type="file"
          accept="image/*"
          multiple
          className="file-hidden"
          disabled={busy}
          aria-label="Upload image"
          onChange={(event) => {
            const files = event.currentTarget.files;
            if (files !== null) {
              uploadFiles(Array.from(files));
            }
            event.currentTarget.value = "";
          }}
        />
      </label>
      {busy && <span className="spinner" aria-hidden="true" />}
      {error !== null && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className="gallery-tiles char-gallery-grid" aria-hidden="true">
          {GALLERY_SKELETONS.map((skeleton) => (
            <div className="skeleton char-gallery-skeleton" key={skeleton} />
          ))}
        </div>
      ) : images.length > 0 ? (
        <div className="gallery-tiles char-gallery-grid">
          <Presence>
            {images.map((image, index) => {
              const url = blobUrl(image.blob_path);
              return (
                <motion.figure
                  className="gallery-tile"
                  key={image.id}
                  layout
                  variants={riseVariants(app)}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  transition={app.reduce ? INSTANT : app.spring.soft}
                >
                  {url !== null ? (
                    <button
                      type="button"
                      className="gallery-tile-open"
                      aria-label={`Open image ${index + 1} of ${images.length} full size`}
                      onClick={() => setPreview(image)}
                    >
                      <img src={url} alt="" loading="lazy" />
                    </button>
                  ) : (
                    <div className="gallery-tile-missing caption">missing</div>
                  )}
                  {isAvatar(image) && (
                    <span className="badge badge-success gallery-tile-badge">
                      <Star size={12} />
                      Avatar
                    </span>
                  )}
                  <div className="gallery-tile-overlay">
                    <button
                      type="button"
                      className="btn btn-icon btn-icon-compact"
                      aria-label="Move image left"
                      data-tip="Move left"
                      disabled={busy || index === 0}
                      onClick={() => moveImage(index, -1)}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-icon-compact"
                      aria-label="Move image right"
                      data-tip="Move right"
                      disabled={busy || index === images.length - 1}
                      onClick={() => moveImage(index, 1)}
                    >
                      <ChevronRight size={16} />
                    </button>
                    <button
                      type="button"
                      className={cx(
                        "btn btn-icon btn-icon-compact",
                        isAvatar(image) && "btn-primary",
                      )}
                      aria-pressed={isAvatar(image)}
                      aria-label={
                        isAvatar(image) ? "Unset as avatar" : `Set as avatar for ${character.name}`
                      }
                      data-tip={isAvatar(image) ? "Unset avatar" : "Set as avatar"}
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          setCharacterImage(character.id, image.id, {
                            avatar: !isAvatar(image),
                          }),
                        )
                      }
                    >
                      <Star size={16} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-icon-compact btn-danger"
                      aria-label="Delete image"
                      data-tip="Delete"
                      disabled={busy}
                      onClick={() => run(() => deleteCharacterImage(character.id, image.id))}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </motion.figure>
              );
            })}
          </Presence>
        </div>
      ) : (
        <div className="empty-card">
          <div className="empty-state">
            <span className="empty-state-icon" aria-hidden="true">
              <Image size={36} />
            </span>
            <span className="empty-state-title">No images yet</span>
            <span className="empty-state-hint">Upload one above to fill the gallery.</span>
          </div>
        </div>
      )}
      {/* Full-screen viewer. AnimatePresence keeps it mounted through its exit;
          it is rendered only for a live blob URL, the same gate the tile uses. */}
      <Presence>
        {preview !== null && previewUrl !== null && (
          <ImageLightbox
            key="gallery-lightbox"
            src={previewUrl}
            label={`${character.name} gallery image`}
            onClose={() => setPreview(null)}
          />
        )}
      </Presence>
    </div>
  );
}
