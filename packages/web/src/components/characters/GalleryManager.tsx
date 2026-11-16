/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CharacterRef } from "../../lib/api-characters";
import Modal from "../ui/Modal";
import GalleryPanel from "./GalleryPanel";

interface GalleryProps {
  character: CharacterRef;
  onClose: () => void;
  onChanged: () => void;
}

/** Modal wrapper around the inline gallery panel. */
export default function GalleryManager(props: GalleryProps) {
  return (
    <Modal title={`Gallery — ${props.character.name}`} onClose={props.onClose}>
      <GalleryPanel character={props.character} onChanged={props.onChanged} />
    </Modal>
  );
}
