/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComponentType } from "react";
import type { IconProps } from "../components/ui/icons";
import {
  ArrowUpRight,
  BookOpen,
  Bot,
  Cable,
  Database,
  Drama,
  Feather,
  FileImage,
  FileJson,
  GitFork,
  Image,
  Info,
  KeyRound,
  Layers,
  LayoutGrid,
  List,
  MessageCircle,
  MessageCirclePlus,
  MessageSquarePlus,
  Moon,
  Pencil,
  Plus,
  Puzzle,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  Star,
  Sun,
  Tag,
  User,
  Users,
  WandSparkles,
} from "../components/ui/icons";

/**
 * Plugin-contributed surfaces (sidebar items, drawer tabs) name icons by
 * Lucide name (e.g. "Sparkles"). Mapping just the icons the app already
 * re-exports keeps the bundle at the curated set — names outside the map
 * fall back to the puzzle piece. Icons that are purely UI affordances
 * (chevrons, close, trash…) are deliberately absent. Shared by the
 * sidebar and the chat drawer's tab bar.
 */
export const PLUGIN_ICONS: Record<string, ComponentType<IconProps>> = {
  ArrowUpRight,
  Bot,
  BookOpen,
  Cable,
  Database,
  Drama,
  Feather,
  FileImage,
  FileJson,
  GitFork,
  Image,
  Info,
  KeyRound,
  Layers,
  LayoutGrid,
  List,
  MessageCircle,
  MessageCirclePlus,
  MessageSquarePlus,
  Moon,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquarePen,
  Star,
  Sun,
  Tag,
  User,
  Users,
  WandSparkles,
};

/** Resolves a plugin's icon name to a curated component (Puzzle fallback). */
export const pluginIcon = (name: string | undefined): ComponentType<IconProps> =>
  (name != null ? PLUGIN_ICONS[name] : undefined) ?? Puzzle;
