/**
 * Objection models (AL4 2.2 .. 2.4 "Objection", section 5). Always bound per query
 * (`XModel.query(trxOrKnex)`), never globally. No `jsonSchema`: validation is done by the
 * contract Zod schemas. Instance columns are declared without initialisers, so they never
 * shadow the values Objection sets.
 */
import { Model } from 'objection';
import type { RelationMappings } from 'objection';
import { STORE_TABLES } from '../../contracts/storage.schema';
import type { Presence } from '../../contracts/storage.schema';

export class PlaceModel extends Model {
  static override tableName = STORE_TABLES.places;
  static override idColumn = 'place_id';
  static override jsonAttributes = ['outline'];

  declare place_id: number;
  declare name: string;
  declare wikimapia_url: string;
  declare location_lon: number;
  declare location_lat: number;
  declare bound_north: number;
  declare bound_south: number;
  declare bound_east: number;
  declare bound_west: number;
  declare outline: [number, number][];
  declare centre_point: string;
  declare outline_shape: string | null;
  declare description: string | null;
  declare is_building: boolean | null;
  declare is_region: boolean | null;
  declare is_deleted: boolean | null;
  declare parent_place_id: number | null;
  declare wikipedia_url: string | null;
  declare address_street: string | null;
  declare address_house_number: string | null;
  declare address_city: string | null;
  declare address_place: string | null;
  declare address_state: string | null;
  declare address_country: string | null;
  declare details_fetched_at: string | Date | null;

  declare comments?: CommentModel[];
  declare tagLinks?: PlaceTagModel[];

  static override relationMappings = (): RelationMappings => ({
    comments: {
      relation: Model.HasManyRelation,
      modelClass: CommentModel,
      join: { from: 'places.place_id', to: 'comments.place_id' },
    },
    tagLinks: {
      relation: Model.HasManyRelation,
      modelClass: PlaceTagModel,
      join: { from: 'places.place_id', to: 'place_tags.place_id' },
    },
  });
}

export class CommentModel extends Model {
  static override tableName = STORE_TABLES.comments;
  static override idColumn = ['place_id', 'num'];

  declare place_id: number;
  declare num: number;
  declare parent_num: number | null;
  declare lang_id: number;
  declare author: string;
  declare author_user_id: number;
  declare author_photo_url: string | null;
  declare message: string;
  declare good_votes: number;
  declare bad_votes: number;
  declare is_blocked: boolean;
  declare is_deleted: boolean;
  declare posted_at_epoch_seconds: number;
  declare moderator_user_id: number;
  declare moderator_name: string | null;
  declare presence: Presence;
  declare position: number | null;

  declare place?: PlaceModel;

  static override relationMappings = (): RelationMappings => ({
    place: {
      relation: Model.BelongsToOneRelation,
      modelClass: PlaceModel,
      join: { from: 'comments.place_id', to: 'places.place_id' },
    },
  });
}

export class TagModel extends Model {
  static override tableName = STORE_TABLES.tags;
  static override idColumn = 'tag_id';

  declare tag_id: number;
  declare title: string;
}

export class PlaceTagModel extends Model {
  static override tableName = STORE_TABLES.placeTags;
  static override idColumn = ['place_id', 'tag_id'];

  declare place_id: number;
  declare tag_id: number;
  declare presence: Presence;
  declare position: number | null;

  declare tag?: TagModel;

  static override relationMappings = (): RelationMappings => ({
    tag: {
      relation: Model.BelongsToOneRelation,
      modelClass: TagModel,
      join: { from: 'place_tags.tag_id', to: 'tags.tag_id' },
    },
  });
}
