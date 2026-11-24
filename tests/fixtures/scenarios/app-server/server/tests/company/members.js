// ::types sqlkit
// Sample SqlKit queries over the `company` schema: a test bed for
// inference across packages.
import { Limit, Offset } from "sqlkit";
import { tables } from "./db";

const { Member, Department } = tables.public;

// Selected columns, a nested relation and paging callbacks.
// The params record `p` is shared: limit and offset come from it.
export const selectMembers = Member ([
  "id",
  "firstName",
  "lastName",
  Department (["id", "name"]),
  Limit (p => p.limit),
  Offset (p => p.offset)
]);

// Chained Prop methods through the props record.
const { id, lastName } = Member.props;

export const selectMemberById = Member ([
  "id",
  "firstName",
  "lastName",
  id.eq (p => p.memberId)
]);

export const orderedMembers = Member ([
  "id",
  "lastName",
  lastName.asc ()
]);

// Composing tags with concat.
export const memberByIdOrdered = selectMemberById.concat (orderedMembers);
