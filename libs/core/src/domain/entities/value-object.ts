/**
 * @fileoverview Value object base class.
 *
 * Why: two value objects with equal components must be interchangeable. Inheriting
 * `equals` from a single place is what stops every VO from reimplementing identity
 * slightly differently and quietly breaking set/map lookups.
 */

export abstract class ValueObject<TProps> {
  protected readonly props: Readonly<TProps>;

  protected constructor(props: TProps) {
    this.props = Object.freeze({ ...props });
  }

  equals(other: ValueObject<TProps>): boolean {
    if (other === null || other === undefined) return false;
    if (other.constructor !== this.constructor) return false;
    return JSON.stringify(this.props) === JSON.stringify(other.props);
  }

  toJSON(): TProps {
    return { ...this.props };
  }
}