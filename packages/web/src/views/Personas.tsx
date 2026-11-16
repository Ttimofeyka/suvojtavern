/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { atom, useAtomValue, useSetAtom } from "jotai";
import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useState } from "react";
import MobileNavButton from "../components/MobileNavButton";
import PersonaEditor from "../components/personas/PersonaEditor";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import { Pencil, Plus, Trash2, User } from "../components/ui/icons";
import { StaggerItem } from "../components/ui/stagger";
import { blobUrl } from "../lib/api";
import type { Persona } from "../lib/api-personas";
import { deletePersona, listPersonas } from "../lib/api-personas";
import { cx } from "../lib/cx";
import { scaleVariants, staggerContainer, useAppMotion } from "../lib/motion";

/**
 * Staggered container that can suppress its entrance. The shared <Stagger>
 * always animates on mount; this view renders from a module-level cache on a
 * revisit, and replaying the cascade on every navigation reads as noise. So the
 * container takes an explicit `initial` (false = render settled) and otherwise
 * reuses the same variant machinery as the shared primitive.
 */
function ListStagger(props: {
  animate: boolean;
  className: string;
  children: ReactNode;
}): ReactElement {
  const app = useAppMotion();
  return (
    <motion.div
      className={cx("stagger", props.className)}
      variants={staggerContainer(app)}
      initial={props.animate ? "hidden" : false}
      animate="visible"
    >
      {props.children}
    </motion.div>
  );
}

// Module scope — the router unmounts this view on every navigation, which
// would otherwise drop the fetched list and replay the skeleton on each
// revisit. Jotai atoms stand in for the Solid module signals: the same
// survive-remount singleton, readable/writable through the shared store.
const personasAtom = atom<Persona[]>([]);
// True only after a *successful* fetch — a failed first load leaves it false
// so the next mount retries the full skeleton flow instead of trusting
// nothing as cache.
const personasLoadedAtom = atom(false);

/** Personas management: your user identities. */
export default function Personas() {
  const app = useAppMotion();
  const personas = useAtomValue(personasAtom);
  const personasLoaded = useAtomValue(personasLoadedAtom);
  const setPersonas = useSetAtom(personasAtom);
  const setPersonasLoaded = useSetAtom(personasLoadedAtom);

  // Per-mount loading: a cached mount starts loaded (no skeleton), a first
  // mount runs the skeleton flow. The background revalidate never flips this
  // back to true — that's what makes it silent. The lazy initializer reads the
  // atom once at setup, matching the Solid module signal's value read.
  const [loading, setLoading] = useState(() => !personasLoaded);
  const [error, setError] = useState<string | null>(null);
  /** Persona currently open in the editor; null while closed or creating. */
  const [editing, setEditing] = useState<Persona | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Persona | null>(null);
  // Rows rise in only when this mount fetched from scratch. On a cached
  // mount (and on the silent revalidate that follows it) the rows render
  // statically — no entrance-animation replay on tab switches. Captured once at
  // setup, so a later atom write never retro-activates the animation.
  const [animate] = useState(() => !personasLoaded);

  const fail =
    (fallback: string) =>
    (err: unknown): void => {
      setError(err instanceof Error ? err.message : fallback);
    };

  const refresh = (): void => {
    listPersonas()
      .then((items) => {
        setPersonas(items);
        setPersonasLoaded(true);
        setError(null);
      })
      .catch(fail("Failed to load personas"))
      .finally(() => setLoading(false));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once — mirrors the Solid onMount. The callbacks read no render values (only stable setters and module atoms), so the first-render closures stay valid for the view's lifetime.
  useEffect(() => {
    refresh();
  }, []);

  const confirmRemove = (): void => {
    const persona = pendingDelete;
    if (persona === null) {
      return;
    }
    setPendingDelete(null);
    deletePersona(persona.id).then(refresh).catch(fail("Failed to delete persona"));
  };

  return (
    <section className="stack page">
      <div className="page-header">
        <MobileNavButton />
        <div className="page-heading">
          <h1>Personas</h1>
          <p className="caption page-desc">The user identities your chats can speak as.</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            <Plus size={16} />
            New persona
          </button>
        </div>
      </div>

      {error !== null && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {!loading ? (
        personas.length > 0 ? (
          <ListStagger animate={animate} className="persona-grid">
            {personas.map((persona) => {
              const avatar = blobUrl(persona.avatar_path);
              return (
                <StaggerItem key={persona.id}>
                  <article className="card card-hover persona-card">
                    <span className="persona-avatar" aria-hidden="true">
                      {avatar !== null ? (
                        <img className="avatar-image" src={avatar} alt="" loading="lazy" />
                      ) : (
                        <User size={20} />
                      )}
                    </span>
                    <div className="persona-main">
                      <div className="row persona-title-row">
                        <span className="persona-name">{persona.name}</span>
                      </div>
                      <p className="caption persona-desc">
                        {persona.description === "" ? "No description" : persona.description}
                      </p>
                    </div>
                    <div className="persona-actions">
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={`Edit ${persona.name}`}
                        data-tip="Edit"
                        onClick={() => {
                          setEditing(persona);
                          setEditorOpen(true);
                        }}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon btn-danger"
                        aria-label={`Delete ${persona.name}`}
                        data-tip="Delete"
                        onClick={() => setPendingDelete(persona)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </article>
                </StaggerItem>
              );
            })}
          </ListStagger>
        ) : (
          <motion.div
            className="empty-card"
            variants={scaleVariants(app, 0.98)}
            initial="hidden"
            animate="visible"
          >
            <div className="empty-state">
              <span className="empty-state-icon" aria-hidden="true">
                <User size={36} />
              </span>
              <span className="empty-state-title">No personas yet</span>
              <span className="empty-state-hint">
                A persona is the identity your messages speak as — create one to be yourself.
              </span>
              <div className="empty-state-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setEditing(null);
                    setEditorOpen(true);
                  }}
                >
                  <Plus size={16} />
                  New persona
                </button>
              </div>
            </div>
          </motion.div>
        )
      ) : (
        <div className="persona-grid" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => i).map((i) => (
            <div className="card persona-card skeleton-row" key={i}>
              <div className="skeleton skeleton-avatar" />
              <div className="skeleton-row-lines">
                <div className="skeleton skeleton-line" style={{ width: "50%" }} />
                <div className="skeleton skeleton-line" style={{ width: "80%" }} />
              </div>
              <div className="skeleton-row-actions">
                <div className="skeleton skeleton-action" />
                <div className="skeleton skeleton-action" />
              </div>
            </div>
          ))}
        </div>
      )}

      {editorOpen && (
        <PersonaEditor
          key={editing?.id ?? "new"}
          persona={editing}
          onClose={() => setEditorOpen(false)}
          onSaved={() => {
            setEditorOpen(false);
            refresh();
          }}
        />
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title="Delete persona?"
          description={
            <>
              <strong>{pendingDelete.name}</strong> will be removed from your identities. Chats that
              already speak as it keep their messages.
            </>
          }
          confirmLabel="Delete persona"
          tone="danger"
          onClose={() => setPendingDelete(null)}
          onConfirm={confirmRemove}
        />
      )}
    </section>
  );
}
