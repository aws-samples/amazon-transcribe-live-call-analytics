import React from 'react';
import { PropTypes } from 'prop-types';

import './CategoryPill.css';
import { Popover } from '@awsui/components-react';

// eslint-disable-next-line import/prefer-default-export, arrow-body-style
export const CategoryAlertPill = (props) => {
  const { categories } = props;
  const regex = process.env.REACT_APP_CATEGORY_REGEX;

  let matches = 0;
  let total = 0;
  const matchList = [];
  if (categories) {
    categories.forEach((category) => {
      if (category.match(regex)) {
        matches += 1;
        matchList.push(category);
      }
      total += 1;
    });
  }

  if (total === 0 || matches === 0) return null;
  const popup = matchList.map((category) => (
    <>
      <span className="category-pill-alert">{category}</span>
      <br />
    </>
  ));
  return (
    <Popover
      dismissButton={false}
      position="right"
      size="small"
      triggerType="custom"
      content={popup}
    >
      <span className="category-pill-alert-icon">{matches}</span>
    </Popover>
  );
};

CategoryAlertPill.propTypes = {
  categories: PropTypes.arrayOf(PropTypes.string),
};

CategoryAlertPill.defaultProps = {
  categories: [],
};
