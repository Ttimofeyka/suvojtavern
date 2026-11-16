/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SuvojTavern icon set — the single source for UI icons.
 *
 * Source: `lucide-react` (official Lucide port for React), ISC license.
 * Every export below re-exports one Lucide icon with house defaults applied:
 * size 18, stroke-width 1.75, stroke `currentColor`, round caps/joins.
 * Components accept the standard `LucideProps` (size, strokeWidth, className,
 * and any SVG attribute). Lucide marks the svg `aria-hidden` automatically
 * unless it receives children or a11y props.
 *
 * Mapping: each `Foo` export wraps Lucide's `Foo`. Renames worth knowing:
 *   WandSparkles    ← wand-sparkles (Lucide's rename of the old "wand2")
 *   TriangleAlert   ← triangle-alert (Lucide's rename of "alert-triangle")
 *   MoreHorizontal  ← more-horizontal (a.k.a. the ellipsis icon)
 *   LayoutGrid      ← layout-grid (the 3x3 grid)
 *   RotateCcw       ← rotate-ccw (regenerate)
 *   KeyRound        ← key-round
 *   GitFork         ← git-fork (branch node graph)
 *   FileJson        ← file-json
 *   FileImage       ← file-image
 *   PanelLeftClose  ← panel-left-close
 *   PanelLeftOpen   ← panel-left-open
 *   PanelTopClose   ← panel-top-close
 *   PanelTopOpen    ← panel-top-open
 *   ArrowUpRight    ← arrow-up-right
 *   ArrowRight      ← arrow-right (continue the last message)
 *   Feather         ← feather (brand mark option)
 *   SquarePen       ← square-pen (Lucide's rename of the old "edit")
 *   Menu            ← menu (mobile nav hamburger)
 *   LogIn/LogOut    ← log-in / log-out (JanitorAI sign-in/out)
 *
 * Nav mapping for C2: Chats=MessageCircle, Characters=Drama, Personas=User,
 * Lorebooks=BookOpen, Presets=SlidersHorizontal, Settings=Settings,
 * brand=logo.png image, settings sections: Profiles=Cable, Plugins=Puzzle,
 * Tracker=Crosshair
 * (also the fallback icon for plugin-contributed sidebar items).
 * Radar=radar (the chat drawer's tracker tab).
 * Regex=regex (Settings → Regex).
 * EyeOff=eye-off (the ghost mark on messages covered by summaries).
 * LoaderCircle=loader-circle (the spinning streaming chip in the compact
 * status group of the chat top bar).
 */

import {
  ArrowRight as LucideArrowRight,
  ArrowUpRight as LucideArrowUpRight,
  BookMarked as LucideBookMarked,
  BookOpen as LucideBookOpen,
  Bot as LucideBot,
  Cable as LucideCable,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  ChevronUp as LucideChevronUp,
  Copy as LucideCopy,
  Crosshair as LucideCrosshair,
  Database as LucideDatabase,
  Download as LucideDownload,
  Drama as LucideDrama,
  ExternalLink as LucideExternalLink,
  EyeOff as LucideEyeOff,
  Feather as LucideFeather,
  FileImage as LucideFileImage,
  FileJson as LucideFileJson,
  GitFork as LucideGitFork,
  GripVertical as LucideGripVertical,
  type LucideIcon,
  Image as LucideImage,
  Info as LucideInfo,
  KeyRound as LucideKeyRound,
  Layers as LucideLayers,
  LayoutGrid as LucideLayoutGrid,
  List as LucideList,
  LoaderCircle as LucideLoaderCircle,
  LogIn as LucideLogIn,
  LogOut as LucideLogOut,
  Menu as LucideMenu,
  MessageCircle as LucideMessageCircle,
  MessageCirclePlus as LucideMessageCirclePlus,
  MessageSquarePlus as LucideMessageSquarePlus,
  Moon as LucideMoon,
  MoreHorizontal as LucideMoreHorizontal,
  PanelLeftClose as LucidePanelLeftClose,
  PanelLeftOpen as LucidePanelLeftOpen,
  PanelTopClose as LucidePanelTopClose,
  PanelTopOpen as LucidePanelTopOpen,
  Pencil as LucidePencil,
  Plus as LucidePlus,
  type LucideProps,
  Puzzle as LucidePuzzle,
  Radar as LucideRadar,
  Regex as LucideRegex,
  RotateCcw as LucideRotateCcw,
  Search as LucideSearch,
  Send as LucideSend,
  Settings as LucideSettings,
  SlidersHorizontal as LucideSlidersHorizontal,
  Sparkles as LucideSparkles,
  Square as LucideSquare,
  SquarePen as LucideSquarePen,
  Star as LucideStar,
  Sun as LucideSun,
  Tag as LucideTag,
  Trash2 as LucideTrash2,
  TriangleAlert as LucideTriangleAlert,
  Upload as LucideUpload,
  User as LucideUser,
  Users as LucideUsers,
  WandSparkles as LucideWandSparkles,
  X as LucideX,
} from "lucide-react";
import type { ReactElement } from "react";

export type IconProps = LucideProps;

const DEFAULT_SIZE = 18;
const DEFAULT_STROKE = 1.75;

/** Wraps a Lucide icon with the house defaults. */
function withDefaults(Icon: LucideIcon) {
  return (props: LucideProps): ReactElement => (
    <Icon
      {...props}
      size={props.size ?? DEFAULT_SIZE}
      strokeWidth={props.strokeWidth ?? DEFAULT_STROKE}
    />
  );
}

export const ArrowRight = withDefaults(LucideArrowRight);
export const ArrowUpRight = withDefaults(LucideArrowUpRight);
export const Bot = withDefaults(LucideBot);
export const BookMarked = withDefaults(LucideBookMarked);
export const BookOpen = withDefaults(LucideBookOpen);
export const Cable = withDefaults(LucideCable);
export const Check = withDefaults(LucideCheck);
export const ChevronDown = withDefaults(LucideChevronDown);
export const ChevronLeft = withDefaults(LucideChevronLeft);
export const ChevronRight = withDefaults(LucideChevronRight);
export const ChevronUp = withDefaults(LucideChevronUp);
export const Copy = withDefaults(LucideCopy);
export const Crosshair = withDefaults(LucideCrosshair);
export const Database = withDefaults(LucideDatabase);
export const Download = withDefaults(LucideDownload);
export const Drama = withDefaults(LucideDrama);
export const ExternalLink = withDefaults(LucideExternalLink);
export const EyeOff = withDefaults(LucideEyeOff);
export const Feather = withDefaults(LucideFeather);
export const FileImage = withDefaults(LucideFileImage);
export const FileJson = withDefaults(LucideFileJson);
export const GitFork = withDefaults(LucideGitFork);
export const GripVertical = withDefaults(LucideGripVertical);
export const Image = withDefaults(LucideImage);
export const Info = withDefaults(LucideInfo);
export const KeyRound = withDefaults(LucideKeyRound);
export const Layers = withDefaults(LucideLayers);
export const LayoutGrid = withDefaults(LucideLayoutGrid);
export const List = withDefaults(LucideList);
export const LoaderCircle = withDefaults(LucideLoaderCircle);
export const LogIn = withDefaults(LucideLogIn);
export const LogOut = withDefaults(LucideLogOut);
export const Menu = withDefaults(LucideMenu);
export const MessageCircle = withDefaults(LucideMessageCircle);
export const MessageCirclePlus = withDefaults(LucideMessageCirclePlus);
export const MessageSquarePlus = withDefaults(LucideMessageSquarePlus);
export const Moon = withDefaults(LucideMoon);
export const MoreHorizontal = withDefaults(LucideMoreHorizontal);
export const PanelLeftClose = withDefaults(LucidePanelLeftClose);
export const PanelLeftOpen = withDefaults(LucidePanelLeftOpen);
export const PanelTopClose = withDefaults(LucidePanelTopClose);
export const PanelTopOpen = withDefaults(LucidePanelTopOpen);
export const Pencil = withDefaults(LucidePencil);
export const Plus = withDefaults(LucidePlus);
export const Puzzle = withDefaults(LucidePuzzle);
export const Radar = withDefaults(LucideRadar);
export const Regex = withDefaults(LucideRegex);
export const RotateCcw = withDefaults(LucideRotateCcw);
export const Search = withDefaults(LucideSearch);
export const Send = withDefaults(LucideSend);
export const Settings = withDefaults(LucideSettings);
export const SlidersHorizontal = withDefaults(LucideSlidersHorizontal);
export const Sparkles = withDefaults(LucideSparkles);
export const Square = withDefaults(LucideSquare);
export const SquarePen = withDefaults(LucideSquarePen);
export const Star = withDefaults(LucideStar);
export const Sun = withDefaults(LucideSun);
export const Tag = withDefaults(LucideTag);
export const Trash2 = withDefaults(LucideTrash2);
export const TriangleAlert = withDefaults(LucideTriangleAlert);
export const Upload = withDefaults(LucideUpload);
export const User = withDefaults(LucideUser);
export const Users = withDefaults(LucideUsers);
export const WandSparkles = withDefaults(LucideWandSparkles);
export const X = withDefaults(LucideX);
