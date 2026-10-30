<?php
/**
 * Plugin Name: GRMC Latest Newsletter
 * Description: Short links that open the most recent sent Mailchimp issue whose subject contains some text, e.g. /grace-notes opens the newest Grace Notes. Set up under Settings → Latest Newsletter.
 * Version:     1.1.0
 * Author:      GRMC
 * License:     GPL-2.0-or-later
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const GRMC_LN_OPTION = 'grmc_ln_settings';
const GRMC_LN_PAGE   = 'grmc-latest-newsletter';

// How long one Mailchimp answer is reused. A new issue shows up within this.
const GRMC_LN_CACHE_SECONDS = 10 * MINUTE_IN_SECONDS;

// Paths a link may never take over.
const GRMC_LN_RESERVED = array( 'wp-admin', 'wp-login', 'wp-login-php', 'wp-json', 'wp-content', 'wp-includes', 'feed', 'xmlrpc-php' );

/* ------------------------------------------------------------------ settings */

function grmc_ln_settings() {
	$s = get_option( GRMC_LN_OPTION, null );
	if ( ! is_array( $s ) ) {
		// First run: start with the Grace Notes link.
		$s = array(
			'api_key' => '',
			'links'   => array( array( 'path' => 'grace-notes', 'match' => 'grace notes' ) ),
		);
	}
	return wp_parse_args( $s, array( 'api_key' => '', 'links' => array() ) );
}

/** A key in wp-config.php (GRMC_MAILCHIMP_API_KEY) wins over the one saved on the settings page. */
function grmc_ln_api_key() {
	if ( defined( 'GRMC_MAILCHIMP_API_KEY' ) && GRMC_MAILCHIMP_API_KEY ) {
		return (string) GRMC_MAILCHIMP_API_KEY;
	}
	return (string) grmc_ln_settings()['api_key'];
}

/** The links: path on this site => text the subject must contain (any case). */
function grmc_ln_links() {
	$links = array();
	foreach ( grmc_ln_settings()['links'] as $l ) {
		$links[ $l['path'] ] = $l['match'];
	}
	return apply_filters( 'grmc_latest_newsletter_links', $links );
}

/* ------------------------------------------------------------------ redirect */

add_action( 'parse_request', 'grmc_ln_maybe_redirect', 1 );

function grmc_ln_maybe_redirect( $wp ) {
	$path  = strtolower( trim( (string) $wp->request, '/' ) );
	$links = grmc_ln_links();
	if ( '' === $path || ! isset( $links[ $path ] ) ) {
		return;
	}

	$found = grmc_ln_latest( $path, $links[ $path ] );
	$url   = $found['url'];
	if ( ! $url ) {
		// Mailchimp couldn't be reached and nothing was found before: send people
		// somewhere useful rather than a blank error.
		$url = apply_filters( 'grmc_latest_newsletter_fallback_url', home_url( '/' ), $path );
	}

	// The target changes every week, so neither browsers nor page caches
	// (Cloudflare, WP Super Cache, ...) may keep this redirect.
	nocache_headers();
	header( 'X-Robots-Tag: noindex' );
	wp_redirect( $url, 302, 'GRMC Latest Newsletter' );
	exit;
}

function grmc_ln_cache_key( $path, $match ) {
	return 'grmc_ln_' . md5( $path . '|' . strtolower( $match ) );
}

/**
 * The newest sent issue for a link: array( 'url', 'subject', 'error', 'stale' ).
 * 'url' is '' when there is none and none was ever found; 'stale' means
 * Mailchimp failed and this is the last issue found before.
 */
function grmc_ln_latest( $path, $match ) {
	$key    = grmc_ln_cache_key( $path, $match );
	$cached = get_transient( $key );
	if ( is_array( $cached ) && ! empty( $cached['url'] ) ) {
		return $cached + array( 'error' => '', 'stale' => false );
	}

	$last  = get_option( $key . '_last', array() );
	$last  = is_array( $last ) ? $last : array();
	$found = grmc_ln_fetch_latest( $match );
	if ( is_wp_error( $found ) || '' === $found['url'] ) {
		$error = is_wp_error( $found ) ? $found->get_error_message() : '';
		if ( $error ) {
			error_log( 'GRMC Latest Newsletter (' . $path . '): ' . $error );
		}
		// Mailchimp is down or the key is wrong: the last issue we found beats
		// no issue. It is kept without expiry for exactly this case.
		return array(
			'url'     => isset( $last['url'] ) ? $last['url'] : '',
			'subject' => isset( $last['subject'] ) ? $last['subject'] : '',
			'error'   => $error,
			'stale'   => ! empty( $last['url'] ),
		);
	}

	set_transient( $key, $found, GRMC_LN_CACHE_SECONDS );
	update_option( $key . '_last', $found, false );
	return $found + array( 'error' => '', 'stale' => false );
}

/**
 * Asks Mailchimp for recent sent campaigns, newest first, and returns the
 * first whose subject matches. Resends ("... resend") are skipped, the same
 * as the social-posts app does.
 *
 * @return array|WP_Error array( 'url', 'subject' ), url '' when nothing matches.
 */
function grmc_ln_fetch_latest( $match, $key = null ) {
	$key = null === $key ? grmc_ln_api_key() : $key;
	$dc  = substr( (string) strrchr( $key, '-' ), 1 );
	if ( '' === $key ) {
		return new WP_Error( 'grmc_ln_key', 'No Mailchimp API key. Add one under Settings → Latest Newsletter.' );
	}
	if ( ! preg_match( '/^[a-z]+\d+$/', $dc ) ) {
		return new WP_Error( 'grmc_ln_key', 'The Mailchimp API key should end in its data center, like "-us21".' );
	}

	$base = apply_filters( 'grmc_latest_newsletter_api_base', 'https://' . $dc . '.api.mailchimp.com/3.0' );
	$url  = add_query_arg(
		array(
			'status'     => 'sent',
			'count'      => 50,
			'sort_field' => 'send_time',
			'sort_dir'   => 'DESC',
			'fields'     => 'campaigns.settings.subject_line,campaigns.archive_url,campaigns.long_archive_url,campaigns.send_time',
		),
		$base . '/campaigns'
	);

	$res = wp_remote_get(
		$url,
		array(
			'timeout' => 8,
			'headers' => array( 'Authorization' => 'Basic ' . base64_encode( 'anystring:' . $key ) ),
		)
	);
	if ( is_wp_error( $res ) ) {
		return new WP_Error( 'grmc_ln_http', 'Could not reach Mailchimp: ' . $res->get_error_message() );
	}
	$code = wp_remote_retrieve_response_code( $res );
	$body = json_decode( wp_remote_retrieve_body( $res ), true );
	if ( 200 !== $code ) {
		$why = is_array( $body ) && ! empty( $body['title'] ) ? $body['title'] : 'request failed';
		return new WP_Error( 'grmc_ln_http', 'Mailchimp answered ' . $code . ': ' . $why . '.' );
	}

	$needle    = strtolower( $match );
	$campaigns = is_array( $body ) && isset( $body['campaigns'] ) ? $body['campaigns'] : array();
	foreach ( $campaigns as $c ) {
		$subject = isset( $c['settings']['subject_line'] ) ? (string) $c['settings']['subject_line'] : '';
		$lower   = strtolower( $subject );
		if ( false === strpos( $lower, $needle ) || false !== strpos( $lower, 'resend' ) ) {
			continue;
		}
		// The long form opens the issue itself; the short eepurl link adds a hop.
		$link = ! empty( $c['long_archive_url'] ) ? $c['long_archive_url'] : ( isset( $c['archive_url'] ) ? $c['archive_url'] : '' );
		$link = esc_url_raw( $link, array( 'https', 'http' ) );
		if ( $link ) {
			return array( 'url' => $link, 'subject' => $subject );
		}
	}
	return array( 'url' => '', 'subject' => '' );
}

/* ------------------------------------------------------------- settings page */

add_action( 'admin_menu', function () {
	add_options_page( 'Latest Newsletter', 'Latest Newsletter', 'manage_options', GRMC_LN_PAGE, 'grmc_ln_render_page' );
} );

add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), function ( $actions ) {
	array_unshift( $actions, '<a href="' . esc_url( admin_url( 'options-general.php?page=' . GRMC_LN_PAGE ) ) . '">Settings</a>' );
	return $actions;
} );

add_action( 'admin_init', function () {
	register_setting(
		GRMC_LN_PAGE,
		GRMC_LN_OPTION,
		array(
			'type'              => 'array',
			'sanitize_callback' => 'grmc_ln_sanitize',
			'show_in_rest'      => false,
		)
	);
} );

/** Cleans what the form sent and reports problems; blank rows are dropped. */
function grmc_ln_sanitize( $input ) {
	$old   = grmc_ln_settings();
	$input = is_array( $input ) ? $input : array();

	// The key field is left blank to keep the saved key; "remove" clears it.
	$key = isset( $input['api_key'] ) ? trim( sanitize_text_field( $input['api_key'] ) ) : '';
	if ( ! empty( $input['remove_key'] ) ) {
		$key = '';
	} elseif ( '' === $key ) {
		$key = $old['api_key'];
	} elseif ( ! preg_match( '/-[a-z]+\d+$/', $key ) ) {
		add_settings_error( GRMC_LN_OPTION, 'key', 'That API key doesn\'t end in a data center like "-us21", so it wasn\'t saved. Copy the whole key from Mailchimp.' );
		$key = $old['api_key'];
	}

	$links = array();
	$seen  = array();
	$rows  = isset( $input['links'] ) && is_array( $input['links'] ) ? $input['links'] : array();
	foreach ( $rows as $row ) {
		$raw   = isset( $row['path'] ) ? (string) $row['path'] : '';
		$path  = sanitize_title( trim( $raw, " /\t" ) );
		$match = isset( $row['match'] ) ? trim( sanitize_text_field( $row['match'] ) ) : '';
		if ( '' === $path && '' === $match ) {
			continue;
		}
		if ( '' === $path || '' === $match ) {
			add_settings_error( GRMC_LN_OPTION, 'half', 'A link needs both a path and subject text. "' . esc_html( $path . $match ) . '" was left out.' );
			continue;
		}
		if ( in_array( $path, GRMC_LN_RESERVED, true ) || 0 === strpos( $path, 'wp-' ) ) {
			add_settings_error( GRMC_LN_OPTION, 'reserved', '"/' . esc_html( $path ) . '" belongs to WordPress, so it was left out.' );
			continue;
		}
		if ( isset( $seen[ $path ] ) ) {
			add_settings_error( GRMC_LN_OPTION, 'dup', '"/' . esc_html( $path ) . '" was listed twice; only the first was kept.' );
			continue;
		}
		$seen[ $path ] = true;
		$links[]       = array( 'path' => $path, 'match' => $match );
	}

	// Start fresh for every link, so a changed key or subject takes effect now
	// rather than after the cache runs out.
	foreach ( array_merge( $old['links'], $links ) as $l ) {
		$ck = grmc_ln_cache_key( $l['path'], $l['match'] );
		delete_transient( $ck );
		if ( $key !== $old['api_key'] ) {
			delete_option( $ck . '_last' );
		}
	}

	return array( 'api_key' => $key, 'links' => $links );
}

function grmc_ln_render_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$s          = grmc_ln_settings();
	$from_const = defined( 'GRMC_MAILCHIMP_API_KEY' ) && GRMC_MAILCHIMP_API_KEY;
	$key        = grmc_ln_api_key();
	$name       = GRMC_LN_OPTION;
	$rows       = $s['links'];
	$rows[]     = array( 'path' => '', 'match' => '' ); // one empty row to add a link
	?>
	<div class="wrap">
		<h1>Latest Newsletter</h1>
		<p>Each link opens the most recent <strong>sent</strong> Mailchimp issue whose subject contains its text (any capitalization; resends are skipped).
			A new issue reaches its link within <?php echo (int) ( GRMC_LN_CACHE_SECONDS / MINUTE_IN_SECONDS ); ?> minutes of sending.</p>
		<form method="post" action="options.php">
			<?php settings_fields( GRMC_LN_PAGE ); ?>

			<h2>Mailchimp</h2>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="grmc-ln-key">API key</label></th>
					<td>
						<?php if ( $from_const ) : ?>
							<p>Set in <code>wp-config.php</code> (<code>GRMC_MAILCHIMP_API_KEY</code>), ending <code><?php echo esc_html( substr( $key, -8 ) ); ?></code>. Remove it there to manage the key here.</p>
						<?php else : ?>
							<input type="password" id="grmc-ln-key" name="<?php echo esc_attr( $name ); ?>[api_key]" class="regular-text" autocomplete="new-password"
								placeholder="<?php echo $key ? esc_attr( 'Saved, ending ' . substr( $key, -8 ) . '. Leave blank to keep it.' ) : 'e.g. 0123abcd…-us21'; ?>">
							<?php if ( $key ) : ?>
								<label style="margin-left:8px"><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[remove_key]" value="1"> Remove saved key</label>
							<?php endif; ?>
							<p class="description">In Mailchimp: Profile → Extras → API keys → Create A Key. Use a key just for the website, so it can be revoked on its own.</p>
						<?php endif; ?>
					</td>
				</tr>
			</table>

			<h2>Links</h2>
			<table class="widefat striped" id="grmc-ln-links" style="max-width:960px">
				<thead><tr><th style="width:30%">Link</th><th style="width:25%">Subject contains</th><th>Opens now</th></tr></thead>
				<tbody>
				<?php foreach ( $rows as $i => $l ) : ?>
					<tr>
						<td>
							<code><?php echo esc_html( trailingslashit( home_url() ) ); ?></code><input type="text" name="<?php echo esc_attr( "{$name}[links][{$i}][path]" ); ?>"
								value="<?php echo esc_attr( $l['path'] ); ?>" placeholder="grace-notes" style="width:10em">
						</td>
						<td><input type="text" name="<?php echo esc_attr( "{$name}[links][{$i}][match]" ); ?>" value="<?php echo esc_attr( $l['match'] ); ?>" placeholder="grace notes" class="regular-text" style="width:100%"></td>
						<td><?php echo '' === $l['path'] ? '<span class="description">Fill in to add a link.</span>' : grmc_ln_status_html( $l['path'], $l['match'] ); ?></td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>
			<p><button type="button" class="button" id="grmc-ln-add">Add another link</button>
				<span class="description" style="margin-left:8px">To remove a link, clear both of its boxes and save.</span></p>

			<?php submit_button(); ?>
		</form>
	</div>
	<script>
	document.getElementById('grmc-ln-add').addEventListener('click', function () {
		var body = document.querySelector('#grmc-ln-links tbody');
		var row = body.lastElementChild.cloneNode(true);
		var n = body.children.length;
		row.querySelectorAll('input').forEach(function (inp) {
			inp.value = '';
			inp.name = inp.name.replace(/\[links\]\[\d+\]/, '[links][' + n + ']');
		});
		row.lastElementChild.innerHTML = '<span class="description">Fill in to add a link.</span>';
		body.appendChild(row);
		row.querySelector('input').focus();
	});
	</script>
	<?php
}

/** Where a link goes right now, for the settings page. */
function grmc_ln_status_html( $path, $match ) {
	$f    = grmc_ln_latest( $path, $match );
	$test = '<a href="' . esc_url( home_url( '/' . $path ) ) . '" target="_blank" rel="noopener">Try it</a>';
	if ( $f['url'] && ! $f['stale'] ) {
		return '<a href="' . esc_url( $f['url'] ) . '" target="_blank" rel="noopener">' . esc_html( $f['subject'] ? $f['subject'] : $f['url'] ) . '</a> · ' . $test;
	}
	if ( $f['url'] ) {
		return '<span style="color:#b32d2e">' . esc_html( $f['error'] ) . '</span><br>Until it\'s fixed, the link opens the last issue found: <a href="' . esc_url( $f['url'] ) . '" target="_blank" rel="noopener">' . esc_html( $f['subject'] ? $f['subject'] : $f['url'] ) . '</a>';
	}
	if ( $f['error'] ) {
		return '<span style="color:#b32d2e">' . esc_html( $f['error'] ) . '</span><br>Until it\'s fixed, the link opens the home page.';
	}
	return '<span style="color:#b32d2e">No sent issue among Mailchimp\'s 50 newest has a subject containing “' . esc_html( $match ) . '”.</span> The link opens the home page.';
}
