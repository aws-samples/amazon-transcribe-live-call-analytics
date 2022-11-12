import React from 'react';
import { PropTypes } from 'prop-types';

import './CategoryPill.css';

// eslint-disable-next-line import/prefer-default-export, arrow-body-style
export const CategoryPill = (props) => {
  const { categories } = props;
  const regex = process.env.REACT_APP_CATEGORY_REGEX;

  let matches = 0;
  let total = 0;
  if (categories) {
    categories.forEach((category) => {
      if (category.match(regex)) matches += 1;
      total += 1;
    });
  }

  if (total === 0) return null;

  const pillClass = matches > 0 ? 'category-pill-alert' : 'category-pill';

  return (
    <span className={pillClass}>
      {matches}
      {'\u002F'}
      {total}
    </span>
  );
};

CategoryPill.propTypes = {
  categories: PropTypes.arrayOf(PropTypes.string),
};

CategoryPill.defaultProps = {
  categories: [],
};
