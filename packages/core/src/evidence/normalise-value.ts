import { normaliseEmail } from '../normalise/email';
import { personNameKey } from '../normalise/person-name';
import { toE164 } from '../normalise/phone';
import { normaliseUrlForCompare } from '../normalise/url';
import type { Field } from '../types';

/** value_norm rules per field (equal value_norm = same value for agreement checks). */
export function normaliseValue(field: Field, value: string): string {
  switch (field) {
    case 'email':
      return normaliseEmail(value);
    case 'phone':
      return toE164(value) ?? value.trim();
    case 'website':
      return normaliseUrlForCompare(value);
    case 'owner_name':
      return personNameKey(value);
    default:
      return value.trim().normalize('NFC');
  }
}
