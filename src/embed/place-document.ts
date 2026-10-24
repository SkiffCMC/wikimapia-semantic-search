import {
  ADDRESS_ITEM_ORDER,
  BARE_WEB_ADDRESS,
  LIST_SEPARATOR,
  PART_SEPARATOR,
  PLACE_DOCUMENT_LABELS,
  tidySpacing,
} from '../../contracts/embeddings.schema';
import type { BuildPlaceDocumentFn, PlaceDocument } from '../../contracts/embeddings.schema';
import type { DetailedPlace, StoredComment, StoredTag } from '../../contracts/storage.schema';

function tagTitles(tags: readonly StoredTag[]): string[] {
  return tags
    .filter((tag) => tag.presence === 'present')
    .map((tag) => tidySpacing(tag.title))
    .filter((title) => title !== '');
}

function addressItems(location: DetailedPlace['location']): string[] {
  const items: string[] = [];
  for (const key of ADDRESS_ITEM_ORDER) {
    const value = location[key];
    if (value === undefined) continue;
    const tidied = tidySpacing(value);
    if (tidied === '' || items.includes(tidied)) continue;
    items.push(tidied);
  }
  return items;
}

function walkComments(siblings: readonly StoredComment[], parts: string[]): void {
  for (const comment of siblings) {
    if (comment.presence === 'present' && !comment.isDeleted && !comment.isBlocked) {
      const message = tidySpacing(comment.message);
      if (message !== '') parts.push(`${PLACE_DOCUMENT_LABELS.comment}${message}`);
    }
    walkComments(comment.replies, parts);
  }
}

export const buildPlaceDocument: BuildPlaceDocumentFn = (place: DetailedPlace): PlaceDocument => {
  const parts: string[] = [];

  const name = tidySpacing(place.name);
  if (name !== '') parts.push(name);

  const tags = tagTitles(place.tags);
  if (tags.length > 0) parts.push(`${PLACE_DOCUMENT_LABELS.tags}${tags.join(LIST_SEPARATOR)}`);

  const items = addressItems(place.location);
  if (items.length > 0) parts.push(`${PLACE_DOCUMENT_LABELS.address}${items.join(LIST_SEPARATOR)}`);

  const description = tidySpacing(place.description.replace(BARE_WEB_ADDRESS, ' '));
  if (description !== '') parts.push(`${PLACE_DOCUMENT_LABELS.description}${description}`);

  walkComments(place.comments, parts);

  return parts.join(PART_SEPARATOR);
};
